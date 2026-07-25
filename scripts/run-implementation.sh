#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/implementation"
RUN_DIR="$AGENT_DIR/artifacts/runs"
STATE_FILE="$AGENT_DIR/state.env"
TASK_FILE="$AGENT_DIR/next-task.md"
REPORT_FILE="$AGENT_DIR/implementation-report.md"
LOCK_DIR="$AGENT_DIR/.cycle.lock"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-implementation.sh [options]

Runs exactly one non-interactive IMPLEMENTER round for .agent/next-task.md.
The executor may edit the allowed workspace but cannot control Git history.
The neutral wrapper validates and creates one local implementation checkpoint.

Options:
  --agent claude|codex  Override IMPLEMENTER_AGENT.
  --model MODEL         Override IMPLEMENTER_MODEL.
  --effort LEVEL        Override IMPLEMENTER_EFFORT.
  --max-rounds N        Override the round limit for this invocation only.
EOF
}

executor_override=""
model_override=""
effort_override=""
max_rounds_override=""
while (( $# > 0 )); do
  case "$1" in
    --agent)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      executor_override="$2"
      shift 2
      ;;
    --model)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      model_override="$2"
      shift 2
      ;;
    --effort)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      effort_override="$2"
      shift 2
      ;;
    --max-rounds)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
      max_rounds_override="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$executor_override" ]]; then
  agent_validate_executor "$executor_override" || exit 2
  implementer_agent="$executor_override"
else
  implementer_agent="$(agent_runtime_executor_config IMPLEMENTER_AGENT claude)" || exit 2
fi
if [[ -n "$model_override" ]]; then
  agent_validate_model "$model_override" || exit 2
  implementer_model="$model_override"
else
  implementer_model="$(agent_runtime_model_config IMPLEMENTER_MODEL sonnet)" || exit 2
fi
if [[ -n "$effort_override" ]]; then
  agent_validate_effort "$effort_override" || exit 2
  implementer_effort="$effort_override"
else
  implementer_effort="$(agent_runtime_effort_config IMPLEMENTER_EFFORT high)" || exit 2
fi

implementer_timeout="$(agent_runtime_config IMPLEMENTER_TIMEOUT_SECONDS 7200 60 43200)" || exit 2
heartbeat_seconds="$(agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300)" || exit 2
termination_grace="$(agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60)" || exit 2
claude_max_turns=""
claude_max_budget_usd=""
claude_context_rotate_tokens=""
if [[ "$implementer_agent" == "claude" ]]; then
  claude_max_turns="$(
    agent_runtime_config CLAUDE_IMPLEMENTER_MAX_TURNS 24 1 1000
  )" || exit 2
  claude_max_budget_usd="$(
    agent_runtime_decimal_config CLAUDE_IMPLEMENTER_MAX_BUDGET_USD 4.00
  )" || exit 2
  claude_context_rotate_tokens="$(
    agent_runtime_config CLAUDE_CONTEXT_ROTATE_TOKENS 160000 10000 1000000
  )" || exit 2
fi
runner="$ROOT_DIR/scripts/agent-runners/$implementer_agent.sh"

mkdir -p "$ARTIFACT_DIR" "$RUN_DIR"

lock_owned=0
if [[ "${AGENT_CYCLE_LOCK_HELD:-0}" != "1" ]]; then
  if ! agent_acquire_lock "$LOCK_DIR" 'standalone implementation'; then
    exit 2
  fi
  lock_owned=1
fi

cleanup() {
  agent_stop_active_process
  if (( lock_owned == 1 )); then
    agent_release_lock "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

preflight_args=(
  --implementation-only
  --implementer-agent "$implementer_agent"
  --implementer-model "$implementer_model"
  --implementer-effort "$implementer_effort"
)
if [[ -n "$max_rounds_override" ]]; then
  preflight_args+=(--max-rounds "$max_rounds_override")
fi
if ! "$ROOT_DIR/scripts/agent-preflight.sh" "${preflight_args[@]}"; then
  printf 'IMPLEMENTER was not started because preflight failed.\n' >&2
  exit 6
fi

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_status" ]]; then
  printf 'Refusing implementation because the Git working tree is not clean.\n' >&2
  printf '%s\n' "$dirty_status" >&2
  printf 'Create a safe checkpoint first; this script will not absorb existing changes.\n' >&2
  exit 2
fi

if [[ ! -x "$runner" ]]; then
  printf 'Executor adapter is missing or not executable: %s\n' "$runner" >&2
  exit 127
fi

agent_runtime_prepare_npm_cache || exit 2

if [[ ! -s "$TASK_FILE" ]]; then
  printf 'Active task file is missing or empty: %s\n' "$TASK_FILE" >&2
  exit 2
fi

active_task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$STATE_FILE" | head -n 1)"
active_task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" | head -n 1)"
current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" | head -n 1)"
configured_max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" | head -n 1)"

[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$configured_max_rounds" =~ ^[1-9][0-9]*$ ]] || configured_max_rounds=3
max_rounds="${max_rounds_override:-$configured_max_rounds}"

if [[ -z "$active_task_id" ]]; then
  printf 'ACTIVE_TASK_ID is empty in %s.\n' "$STATE_FILE" >&2
  exit 2
fi
if [[ "$active_task_status" != "READY" && "$active_task_status" != "NEEDS_CHANGES" ]]; then
  printf 'Active task is not ready for implementation: %s\n' "$active_task_status" >&2
  exit 3
fi
if (( current_round >= max_rounds )); then
  printf 'Maximum review rounds reached (%s). Return control to the project owner.\n' "$max_rounds" >&2
  exit 3
fi

implementation_round=$((current_round + 1))
base_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
base_git_config="$(git -C "$ROOT_DIR" config --local --list --show-origin 2>/dev/null)"
base_git_refs="$(git -C "$ROOT_DIR" show-ref 2>/dev/null || true)"
run_id="implementation-r${implementation_round}-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
prompt_file="$ARTIFACT_DIR/prompt-round-${implementation_round}.md"
agent_log="$ARTIFACT_DIR/${implementer_agent}-round-${implementation_round}.log"
manifest_file="$RUN_DIR/${run_id}.env"
events_file="$ARTIFACT_DIR/${run_id}.events.jsonl"
usage_file="$ARTIFACT_DIR/${run_id}.usage.json"

agent_prepare_role_session \
  "$active_task_id" IMPLEMENTER "$implementer_agent" "$implementer_model" "$implementer_effort"

agent_write_run_manifest \
  "$manifest_file" "$run_id" "$active_task_id" "$implementation_round" \
  IMPLEMENTER "$implementer_agent" "$implementer_model" "$implementer_effort" \
  workspace-write-no-git "$implementer_timeout" "$base_commit" PENDING \
  .agent/implementation-report.md
agent_append_run_session \
  "$manifest_file" "$AGENT_SESSION_ID" "$AGENT_SESSION_MODE" \
  "${events_file#"$ROOT_DIR/"}" "${usage_file#"$ROOT_DIR/"}"
agent_append_run_limits \
  "$manifest_file" "$claude_max_turns" "$claude_max_budget_usd" \
  "$claude_context_rotate_tokens"

if [[ -n "$AGENT_SESSION_ROTATED_FROM" ]]; then
  context_instructions="This is a deliberately compacted continuation of the same
task-scoped IMPLEMENTER role. The previous raw session
$AGENT_SESSION_ROTATED_FROM exceeded the context guard and was closed after a
Git recovery checkpoint. Reconstruct only the working set from PROJECT.md,
.agent/next-task.md, .agent/latest-review.md, .agent/implementation-report.md,
the current Git history/status/diff and directly relevant code or specification
sections. Do not reread every unchanged engineering document."
elif [[ "$AGENT_SESSION_MODE" == "resume" ]]; then
  context_instructions="This is a continuation of the same task-scoped IMPLEMENTER conversation.
Do not reread unchanged protocol and engineering documents already present in
the conversation. Re-read PROJECT.md, .agent/next-task.md,
.agent/latest-review.md, .agent/implementation-report.md, current Git status and
diff, then open only changed or directly relevant specification sections and
code. Confirm the checkpointed workspace rather than assuming prior tool state."
else
  context_instructions="Read, in order: PROJECT.md, AGENT_PROTOCOL.md,
.agent/roles/IMPLEMENTER.md, PROJECT_SPEC.md,
docs/engineering/SOURCE_SCENE.md, docs/engineering/REACTOR_POOL_SYSTEM.md,
docs/engineering/REACTOR_MODEL.md, REVIEW_CONTRACT.md, .agent/next-task.md,
.agent/latest-review.md, .agent/implementation-report.md, README.md, the current
Git status, and all directly relevant code."
fi

cat >"$prompt_file" <<EOF
You are one bounded Agent invocation with the explicitly assigned role
IMPLEMENTER. Your executor is $implementer_agent, model is $implementer_model,
and effort is $implementer_effort. Do not infer a role from the executor name
and do not switch roles.

Task: $active_task_id
Round: $implementation_round of at most $max_rounds
Base commit: $base_commit
Role session: ${AGENT_SESSION_ID:-pending} ($AGENT_SESSION_MODE)
Session generation: $AGENT_SESSION_GENERATION
Run manifest: ${manifest_file#"$ROOT_DIR/"}

$context_instructions

Implement the active task comprehensively. If the latest verdict is
CHANGES_REQUIRED, address every valid Blocker and Major first. Make reasonable
technical decisions inside the owner's approved scope; do not invent unrelated
features. Follow the protected SOURCE and reactor-pool baselines. Record
continuous operation, session reset, water coupling, grating support, glass
damage/fracture, audio activation, changed RP-* and reactor component IDs,
sources, geometry, state links, proxy labels, deliberate abstractions,
verification, and open gap IDs in .agent/implementation-report.md.

Keep the autonomous slice efficient: batch related reads and edits, avoid
re-reading unchanged files or printing large generated output, stabilize the
code before running the full validation suite, and perform one consolidated
Playwright evidence pass near the end instead of repeatedly replaying the same
viewports. A neutral budget/turn guard may stop this process early; in that case
leave a coherent filesystem state and do not attempt to bypass the guard.

You may edit source, styles, tests, package configuration, and current progress
facts. The collaboration control plane is protected: do not modify
PROJECT_SPEC.md, AGENT_PROTOCOL.md, REVIEW_CONTRACT.md, AGENTS.md, CLAUDE.md,
.gitignore, .claude/, .codex/, .vscode/, docs/, references/, .agent/roles/,
any .agent/ file other than implementation-report.md and ignored artifacts, or
Agent/validation control scripts. Do not stage or commit. Never push, deploy,
reset, clean, rebase, switch branches, inspect secret stores, expose credentials,
or start another Agent.

Run ./scripts/run-validation.sh as a standalone command; do not chain diagnostic
echo/cat commands onto it. Use the Write/Edit tools, not a shell heredoc, for
temporary source probes in ignored artifact paths. For page appearance or behavior changes, use
Playwright MCP—not a Bash Playwright script—to exercise the required viewports,
session reset, first-interaction activation, reactor-pool operation and pulse,
water response, glass interactions, audio activation, responsive layout, and
browser console. Preserve useful evidence only in ignored artifact paths.

Replace .agent/implementation-report.md with a complete report. Include
"- Implementer runtime: $implementer_agent / $implementer_model / $implementer_effort"
in its metadata. Report passes, failures, NOT CONFIGURED items, unverified areas,
remaining risks, and the exact handoff focus for the next REVIEWER. Then stop;
the neutral wrapper will verify, validate, and create the Git checkpoint.
EOF

printf 'Starting IMPLEMENTER round %s/%s for %s\n' \
  "$implementation_round" "$max_rounds" "$active_task_id"
printf 'Runtime: %s / %s / %s\n' \
  "$implementer_agent" "$implementer_model" "$implementer_effort"
printf 'Role session: %s (%s)\n' "${AGENT_SESSION_ID:-assigned-by-executor}" "$AGENT_SESSION_MODE"
if [[ "$implementer_agent" == "claude" ]]; then
  printf 'Claude guard: max %s turns / $%s API-equivalent / rotate at %s cached tokens\n' \
    "$claude_max_turns" "$claude_max_budget_usd" "$claude_context_rotate_tokens"
fi

export AGENT_SESSION_ID AGENT_SESSION_MODE AGENT_SESSION_GENERATION
export AGENT_CLAUDE_MAX_TURNS="$claude_max_turns"
export AGENT_CLAUDE_MAX_BUDGET_USD="$claude_max_budget_usd"
export AGENT_EVENT_FILE="$events_file"
export AGENT_LIVE_TELEMETRY_EXECUTOR="$implementer_agent"
run_agent_process \
  "IMPLEMENTER ($implementer_agent) round $implementation_round/$max_rounds" \
  "$implementer_timeout" "$heartbeat_seconds" "$termination_grace" "$agent_log" -- \
  "$runner" IMPLEMENTER "$implementer_model" "$implementer_effort" "$prompt_file" -
implementer_exit=$?
unset AGENT_EVENT_FILE AGENT_LIVE_TELEMETRY_EXECUTOR
unset AGENT_CLAUDE_MAX_TURNS AGENT_CLAUDE_MAX_BUDGET_USD

if (( implementer_exit == 0 )); then
  run_status="SUCCESS"
else
  run_status="$AGENT_RUN_REASON"
fi
agent_finalize_role_session "$implementer_agent" "$events_file" "$run_status"
agent_record_telemetry "$implementer_agent" "$events_file" "$usage_file"
session_rotation="NO"
if agent_mark_role_session_rotation \
  "$implementer_agent" "$usage_file" "${claude_context_rotate_tokens:-1000000}"; then
  session_rotation="REQUIRED"
fi
printf 'RESOLVED_SESSION_ID=%s\n' "$AGENT_SESSION_ID" >>"$manifest_file"
printf 'SESSION_ROTATION_REQUIRED=%s\n' "$session_rotation" >>"$manifest_file"
agent_finish_run_manifest \
  "$manifest_file" "$run_status" "$implementer_exit" "$AGENT_RUN_REASON"

if (( implementer_exit != 0 )); then
  agent_record_stop \
    IMPLEMENTER "$AGENT_RUN_REASON" "$implementer_exit" "$agent_log" "$usage_file"
  printf 'IMPLEMENTER stopped (exit %s, reason %s). Changes were left for inspection.\n' \
    "$implementer_exit" "$AGENT_RUN_REASON" >&2
  printf 'Log: %s\n' "$agent_log" >&2
  exit "$implementer_exit"
fi

if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$base_commit" ]]; then
  agent_record_stop IMPLEMENTER GIT_HISTORY_CHANGED 4 "$agent_log"
  printf 'IMPLEMENTER changed Git history. Stopping without further mutation.\n' >&2
  exit 4
fi
current_git_config="$(git -C "$ROOT_DIR" config --local --list --show-origin 2>/dev/null)"
current_git_refs="$(git -C "$ROOT_DIR" show-ref 2>/dev/null || true)"
if [[ "$current_git_config" != "$base_git_config" || "$current_git_refs" != "$base_git_refs" ]]; then
  agent_record_stop IMPLEMENTER GIT_CONTROL_PLANE_CHANGED 4 "$agent_log"
  printf 'IMPLEMENTER changed local Git configuration or refs.\n' >&2
  exit 4
fi
if ! git -C "$ROOT_DIR" diff --cached --quiet --; then
  agent_record_stop IMPLEMENTER PRESTAGED_CHANGES 4 "$agent_log"
  printf 'IMPLEMENTER staged changes despite the boundary.\n' >&2
  exit 4
fi

is_protected_implementation_path() {
  case "$1" in
    README.md|PROJECT_SPEC.md|AGENT_PROTOCOL.md|REVIEW_CONTRACT.md|AGENTS.md|CLAUDE.md|.gitignore) return 0 ;;
    docs/*|references/*|.vscode/*|.agent/roles/*) return 0 ;;
    .claude/*|.codex/*) return 0 ;;
    .agent/implementation-report.md|.agent/artifacts/*) return 1 ;;
    .agent/*) return 0 ;;
    scripts/agent-*.sh|scripts/agent-runners/*|scripts/generate-cycle-summary.sh|scripts/run-implementation.sh|scripts/run-review.sh|scripts/run-validation.sh|scripts/test-agent-runtime.sh|scripts/lib/agent-runtime.sh) return 0 ;;
    *) return 1 ;;
  esac
}

protected_violation=0
while IFS= read -r -d '' changed_path; do
  [[ -n "$changed_path" ]] || continue
  if is_protected_implementation_path "$changed_path"; then
    printf 'IMPLEMENTER modified protected control-plane file: %s\n' "$changed_path" >&2
    protected_violation=1
  fi
done < <(
  git -C "$ROOT_DIR" diff --name-only -z --
  git -C "$ROOT_DIR" ls-files --others --exclude-standard -z
)
if (( protected_violation != 0 )); then
  agent_record_stop IMPLEMENTER POLICY_VIOLATION 4 "$agent_log"
  printf 'Stopping before validation or staging. Changes remain for owner inspection.\n' >&2
  exit 4
fi

implementation_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -z "$implementation_status" ]]; then
  agent_record_stop IMPLEMENTER NO_REPOSITORY_CHANGES 5 "$agent_log"
  printf 'IMPLEMENTER produced no repository changes. No checkpoint created.\n' >&2
  exit 5
fi

if git -C "$ROOT_DIR" diff --quiet -- "$REPORT_FILE" || \
   grep -Fq 'IMPLEMENTATION_STATUS: NOT_REPORTED' "$REPORT_FILE"; then
  agent_record_stop IMPLEMENTER IMPLEMENTATION_REPORT_MISSING 5 "$agent_log"
  printf 'IMPLEMENTER did not replace the implementation report.\n' >&2
  exit 5
fi

if ! grep -Fq -- "- Implementer runtime: $implementer_agent / $implementer_model / $implementer_effort" \
  "$REPORT_FILE"; then
  agent_record_stop IMPLEMENTER IMPLEMENTATION_RUNTIME_MISSING 5 "$agent_log"
  printf 'Implementation report does not record the assigned runtime.\n' >&2
  exit 5
fi

if "$ROOT_DIR/scripts/run-validation.sh"; then
  validation_status="PASS"
  validation_exit=0
else
  validation_exit=$?
  validation_status="FAIL"
fi

{
  printf '\n## Automation wrapper result\n\n'
  printf -- '- Base commit: `%s`\n' "$base_commit"
  printf -- '- Implementer runtime: `%s / %s / %s`\n' \
    "$implementer_agent" "$implementer_model" "$implementer_effort"
  printf -- '- Agent process: PASS (exit 0)\n'
  printf -- '- Unified validation: %s (exit %s)\n' "$validation_status" "$validation_exit"
  printf -- '- Checkpoint: created by `scripts/run-implementation.sh` after this report\n'
} >>"$REPORT_FILE"

state_tmp="$AGENT_DIR/state.env.tmp"
while IFS= read -r state_line; do
  case "$state_line" in
    LAST_IMPLEMENTER_AGENT=*|LAST_IMPLEMENTER_MODEL=*|LAST_IMPLEMENTER_EFFORT=*) ;;
    *) printf '%s\n' "$state_line" ;;
  esac
done <"$STATE_FILE" >"$state_tmp"
{
  printf 'LAST_IMPLEMENTER_AGENT=%s\n' "$implementer_agent"
  printf 'LAST_IMPLEMENTER_MODEL=%s\n' "$implementer_model"
  printf 'LAST_IMPLEMENTER_EFFORT=%s\n' "$implementer_effort"
} >>"$state_tmp"
mv "$state_tmp" "$STATE_FILE"

if ! git -C "$ROOT_DIR" add --all; then
  agent_record_stop WRAPPER CHECKPOINT_PERMISSION 4 "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log"
  printf 'Could not stage the implementation checkpoint. Changes were preserved.\n' >&2
  exit 4
fi
if git -C "$ROOT_DIR" diff --cached --quiet; then
  printf 'No staged changes remained after implementation.\n' >&2
  exit 5
fi

git -C "$ROOT_DIR" \
  -c core.hooksPath=/dev/null \
  -c commit.gpgSign=false \
  commit -m "agent: implementation round $implementation_round" \
  >"$ARTIFACT_DIR/git-commit-round-${implementation_round}.log" 2>&1
commit_exit=$?
if (( commit_exit != 0 )); then
  commit_reason="$(agent_classify_log "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log")"
  agent_record_stop WRAPPER "$commit_reason" "$commit_exit" "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log"
  printf 'Could not create implementation checkpoint (exit %s).\n' "$commit_exit" >&2
  exit "$commit_exit"
fi

result_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf 'Implementation checkpoint exists but the working tree is not clean.\n' >&2
  git -C "$ROOT_DIR" status --short >&2
  exit 4
fi

agent_clear_stop
printf 'IMPLEMENTER checkpoint: %s\n' "$result_commit"
printf 'Unified validation before checkpoint: %s\n' "$validation_status"
printf 'Runtime log: %s\n' "$agent_log"
