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

Starts or resumes the task-scoped read-only MONITOR conversation for an event
boundary. It never edits the repository or starts a work Agent. The report is
stored in ignored artifacts.

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
claude_max_turns=""
claude_max_budget_usd=""
claude_context_rotate_tokens=""
if [[ "$monitor_agent" == "claude" ]]; then
  claude_max_turns="$(
    agent_runtime_config CLAUDE_MONITOR_MAX_TURNS 8 1 1000
  )" || exit 2
  claude_max_budget_usd="$(
    agent_runtime_decimal_config CLAUDE_MONITOR_MAX_BUDGET_USD 1.00
  )" || exit 2
  claude_context_rotate_tokens="$(
    agent_runtime_config CLAUDE_CONTEXT_ROTATE_TOKENS 160000 10000 1000000
  )" || exit 2
fi
runner="$ROOT_DIR/scripts/agent-runners/$monitor_agent.sh"
[[ -x "$runner" ]] || { printf 'Monitor adapter is unavailable: %s\n' "$runner" >&2; exit 127; }

mkdir -p "$ARTIFACT_DIR" "$RUN_DIR"
event_slug="$(printf '%s' "$event" | tr -c '[:alnum:]_.-' '_')"
run_id="monitor-${event_slug}-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
prompt_file="$ARTIFACT_DIR/${run_id}-prompt.md"
report_file="$ARTIFACT_DIR/${run_id}-report.md"
log_file="$ARTIFACT_DIR/${run_id}.log"
manifest_file="$RUN_DIR/${run_id}.env"
events_file="$ARTIFACT_DIR/${run_id}-report.md.events.$([[ "$monitor_agent" == "codex" ]] && printf jsonl || printf json)"
usage_file="$ARTIFACT_DIR/${run_id}.usage.json"
task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$AGENT_DIR/state.env" | head -n 1)"
head_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"

agent_prepare_role_session \
  "$task_id" MONITOR "$monitor_agent" "$monitor_model" "$monitor_effort"

agent_write_run_manifest \
  "$manifest_file" "$run_id" "$task_id" 0 MONITOR \
  "$monitor_agent" "$monitor_model" "$monitor_effort" read-only \
  "$monitor_timeout" "$head_commit" "$head_commit" "$report_file"
agent_append_run_session \
  "$manifest_file" "$AGENT_SESSION_ID" "$AGENT_SESSION_MODE" \
  "${events_file#"$ROOT_DIR/"}" "${usage_file#"$ROOT_DIR/"}"
agent_append_run_limits \
  "$manifest_file" "$claude_max_turns" "$claude_max_budget_usd" \
  "$claude_context_rotate_tokens"

if [[ -n "$AGENT_SESSION_ROTATED_FROM" ]]; then
  context_instructions="The prior raw MONITOR session
$AGENT_SESSION_ROTATED_FROM exceeded its context guard. Continue the same
task-scoped MONITOR role from persisted supervisor state, event logs and run
manifests; do not reconstruct unrelated business history."
elif [[ "$AGENT_SESSION_MODE" == "resume" ]]; then
  context_instructions="Resume this task-scoped MONITOR conversation. Re-read
only current supervisor state, the new event evidence and control files that
changed since the previous event."
else
  context_instructions="Initialize the task-scoped MONITOR conversation from
the current project protocol, supervisor state and this event."
fi

cat >"$prompt_file" <<EOF
You are one event-driven Agent invocation with the explicitly assigned role
MONITOR. You are not IMPLEMENTER or REVIEWER. Do not judge business quality,
edit files, start another Agent, or change Git. Your sandbox is read-only.

Event: $event
Stage: $stage
Exit code: $event_exit
Related log: ${event_log:-not-provided}
Run manifest: ${manifest_file#"$ROOT_DIR/"}
Role session: ${AGENT_SESSION_ID:-assigned-by-executor} ($AGENT_SESSION_MODE)
Session generation: $AGENT_SESSION_GENERATION

$context_instructions

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
MONITOR_ACTION: CONTINUE

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

export AGENT_SESSION_ID AGENT_SESSION_MODE AGENT_SESSION_GENERATION
export AGENT_CLAUDE_MAX_TURNS="$claude_max_turns"
export AGENT_CLAUDE_MAX_BUDGET_USD="$claude_max_budget_usd"
export AGENT_EVENT_FILE="$events_file"
run_agent_process \
  "MONITOR ($monitor_agent) event $event" \
  "$monitor_timeout" "$heartbeat_seconds" "$termination_grace" "$log_file" -- \
  "$runner" MONITOR "$monitor_model" "$monitor_effort" "$prompt_file" "$report_file"
monitor_exit=$?
unset AGENT_EVENT_FILE AGENT_CLAUDE_MAX_TURNS AGENT_CLAUDE_MAX_BUDGET_USD
if (( monitor_exit == 0 )); then
  run_status="SUCCESS"
else
  run_status="$AGENT_RUN_REASON"
fi
agent_finalize_role_session "$monitor_agent" "$events_file" "$run_status"
agent_record_telemetry "$monitor_agent" "$events_file" "$usage_file"
session_rotation="NO"
if agent_mark_role_session_rotation \
  "$monitor_agent" "$usage_file" "${claude_context_rotate_tokens:-1000000}"; then
  session_rotation="REQUIRED"
fi
printf 'RESOLVED_SESSION_ID=%s\n' "$AGENT_SESSION_ID" >>"$manifest_file"
printf 'SESSION_ROTATION_REQUIRED=%s\n' "$session_rotation" >>"$manifest_file"
agent_finish_run_manifest \
  "$manifest_file" "$run_status" "$monitor_exit" "$AGENT_RUN_REASON"
if (( monitor_exit != 0 )); then
  printf 'MONITOR event analysis failed (exit %s, reason %s).\n' \
    "$monitor_exit" "$AGENT_RUN_REASON" >&2
  exit "$monitor_exit"
fi

if ! grep -Fqx '# Monitor Event Report' "$report_file" || \
   [[ "$(grep -Ec '^MONITOR_ACTION: (WAIT_FOR_QUOTA|RETRY_PREFLIGHT|STOP_OWNER|CONTROL_REPAIR_REQUIRED|CONTINUE)$' "$report_file" || true)" != "1" ]]; then
  printf 'MONITOR report format is invalid: %s\n' "$report_file" >&2
  exit 4
fi

printf 'Monitor report: %s\n' "$report_file"
grep -E '^MONITOR_ACTION:' "$report_file"
