#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/supervisor"
RUN_DIR="$AGENT_DIR/artifacts/runs"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"
STOP_FILE="$AGENT_DIR/artifacts/runtime/last-stop.env"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-monitor.sh --event TYPE [options]

Starts one read-only MONITOR Agent for an event boundary. It never edits the
repository or starts a work Agent. The report is stored in ignored artifacts.

Options:
  --event TYPE
  --stage STAGE
  --exit-code CODE
  --log-file PATH
  --agent claude|codex
  --model MODEL
  --effort LEVEL
EOF
}

event=""
stage="UNKNOWN"
event_exit="UNKNOWN"
event_log=""
monitor_agent="$(agent_runtime_executor_config MONITOR_AGENT codex)" || exit 2
monitor_model="$(agent_runtime_model_config MONITOR_MODEL gpt-5.6-terra)" || exit 2
monitor_effort="$(agent_runtime_effort_config MONITOR_EFFORT medium)" || exit 2

while (( $# > 0 )); do
  case "$1" in
    --event) event="${2:-}"; shift 2 ;;
    --stage) stage="${2:-}"; shift 2 ;;
    --exit-code) event_exit="${2:-}"; shift 2 ;;
    --log-file) event_log="${2:-}"; shift 2 ;;
    --agent) monitor_agent="${2:-}"; shift 2 ;;
    --model) monitor_model="${2:-}"; shift 2 ;;
    --effort) monitor_effort="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown monitor option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$event" ]] || { printf 'MONITOR event is required.\n' >&2; exit 2; }
agent_validate_executor "$monitor_agent" || exit 2
agent_validate_model "$monitor_model" || exit 2
agent_validate_effort "$monitor_effort" || exit 2

monitor_timeout="$(agent_runtime_config MONITOR_TIMEOUT_SECONDS 900 60 7200)" || exit 2
heartbeat_seconds="$(agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300)" || exit 2
termination_grace="$(agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60)" || exit 2
runner="$ROOT_DIR/scripts/agent-runners/$monitor_agent.sh"
[[ -x "$runner" ]] || { printf 'Monitor adapter is unavailable: %s\n' "$runner" >&2; exit 127; }

mkdir -p "$ARTIFACT_DIR" "$RUN_DIR"
event_slug="$(printf '%s' "$event" | tr -c '[:alnum:]_.-' '_')"
run_id="monitor-${event_slug}-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
prompt_file="$ARTIFACT_DIR/${run_id}-prompt.md"
report_file="$ARTIFACT_DIR/${run_id}-report.md"
log_file="$ARTIFACT_DIR/${run_id}.log"
manifest_file="$RUN_DIR/${run_id}.env"
task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$AGENT_DIR/state.env" | head -n 1)"
head_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"

agent_write_run_manifest \
  "$manifest_file" "$run_id" "$task_id" 0 MONITOR \
  "$monitor_agent" "$monitor_model" "$monitor_effort" read-only \
  "$monitor_timeout" "$head_commit" "$head_commit" "$report_file"

cat >"$prompt_file" <<EOF
You are one event-driven Agent invocation with the explicitly assigned role
MONITOR. You are not IMPLEMENTER or REVIEWER. Do not judge business quality,
edit files, start another Agent, or change Git. Your sandbox is read-only.

Event: $event
Stage: $stage
Exit code: $event_exit
Related log: ${event_log:-not-provided}
Run manifest: ${manifest_file#"$ROOT_DIR/"}

Read PROJECT.md, AGENT_PROTOCOL.md, .agent/roles/MONITOR.md,
.agent/state.env, .agent/runtime.env, the current Git status, the latest cycle
summary, $STOP_FILE when present, and only the control/process evidence needed
to classify this event.

Output a concise Simplified Chinese Markdown report. The first heading must be
"# Monitor Event Report". Include exactly one standalone action line chosen
from:

MONITOR_ACTION: WAIT_FOR_QUOTA
MONITOR_ACTION: RETRY_PREFLIGHT
MONITOR_ACTION: STOP_OWNER
MONITOR_ACTION: CONTROL_REPAIR_REQUIRED

Explain the evidence, whether a work Agent is still alive, whether Git/control
state is safe, and the next mechanical action. Do not propose business fixes.
EOF

if ! "$ROOT_DIR/scripts/agent-preflight.sh" \
  --review-only --allow-dirty --skip-git-write \
  --reviewer-agent "$monitor_agent" \
  --reviewer-model "$monitor_model" \
  --reviewer-effort "$monitor_effort"; then
  printf 'MONITOR was not started because executor preflight failed.\n' >&2
  exit 6
fi

run_agent_process \
  "MONITOR ($monitor_agent) event $event" \
  "$monitor_timeout" "$heartbeat_seconds" "$termination_grace" "$log_file" -- \
  "$runner" MONITOR "$monitor_model" "$monitor_effort" "$prompt_file" "$report_file"
monitor_exit=$?
if (( monitor_exit != 0 )); then
  printf 'MONITOR event analysis failed (exit %s, reason %s).\n' \
    "$monitor_exit" "$AGENT_RUN_REASON" >&2
  exit "$monitor_exit"
fi

if ! grep -Fqx '# Monitor Event Report' "$report_file" || \
   [[ "$(grep -Ec '^MONITOR_ACTION: (WAIT_FOR_QUOTA|RETRY_PREFLIGHT|STOP_OWNER|CONTROL_REPAIR_REQUIRED)$' "$report_file" || true)" != "1" ]]; then
  printf 'MONITOR report format is invalid: %s\n' "$report_file" >&2
  exit 4
fi

printf 'Monitor report: %s\n' "$report_file"
grep -E '^MONITOR_ACTION:' "$report_file"
