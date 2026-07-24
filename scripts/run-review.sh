#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/review"
RUN_DIR="$AGENT_DIR/artifacts/runs"
STATE_FILE="$AGENT_DIR/state.env"
LATEST_REVIEW="$AGENT_DIR/latest-review.md"
HISTORY_DIR="$AGENT_DIR/review-history"
LOCK_DIR="$AGENT_DIR/.cycle.lock"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-review.sh [options] [target-commit] [base-commit]

Defaults:
  target-commit  HEAD
  base-commit    target-commit^ (or the empty tree for an initial commit)

Options:
  --agent claude|codex  Override REVIEWER_AGENT.
  --model MODEL         Override REVIEWER_MODEL.
  --effort LEVEL        Override REVIEWER_EFFORT.
  --max-rounds N        Override the round limit for this invocation only.

The tree must be clean. The wrapper runs validation, starts one REVIEWER with a
read-only profile, validates the report, then installs and archives it.
EOF
}

executor_override=""
model_override=""
effort_override=""
max_rounds_override=""
positional=()
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
    --)
      shift
      while (( $# > 0 )); do positional+=("$1"); shift; done
      ;;
    -*)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done
if (( ${#positional[@]} > 2 )); then
  usage >&2
  exit 2
fi

if [[ -n "$executor_override" ]]; then
  agent_validate_executor "$executor_override" || exit 2
  reviewer_agent="$executor_override"
else
  reviewer_agent="$(agent_runtime_executor_config REVIEWER_AGENT codex)" || exit 2
fi
if [[ -n "$model_override" ]]; then
  agent_validate_model "$model_override" || exit 2
  reviewer_model="$model_override"
else
  reviewer_model="$(agent_runtime_model_config REVIEWER_MODEL gpt-5.6-sol)" || exit 2
fi
if [[ -n "$effort_override" ]]; then
  agent_validate_effort "$effort_override" || exit 2
  reviewer_effort="$effort_override"
else
  reviewer_effort="$(agent_runtime_effort_config REVIEWER_EFFORT high)" || exit 2
fi

reviewer_timeout="$(agent_runtime_config REVIEWER_TIMEOUT_SECONDS 3600 60 43200)" || exit 2
heartbeat_seconds="$(agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300)" || exit 2
termination_grace="$(agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60)" || exit 2
claude_max_turns=""
claude_max_budget_usd=""
claude_context_rotate_tokens=""
if [[ "$reviewer_agent" == "claude" ]]; then
  claude_max_turns="$(
    agent_runtime_config CLAUDE_REVIEWER_MAX_TURNS 24 1 1000
  )" || exit 2
  claude_max_budget_usd="$(
    agent_runtime_decimal_config CLAUDE_REVIEWER_MAX_BUDGET_USD 4.00
  )" || exit 2
  claude_context_rotate_tokens="$(
    agent_runtime_config CLAUDE_CONTEXT_ROTATE_TOKENS 160000 10000 1000000
  )" || exit 2
fi
runner="$ROOT_DIR/scripts/agent-runners/$reviewer_agent.sh"

mkdir -p "$ARTIFACT_DIR" "$HISTORY_DIR" "$RUN_DIR"

lock_owned=0
if [[ "${AGENT_CYCLE_LOCK_HELD:-0}" != "1" ]]; then
  if ! agent_acquire_lock "$LOCK_DIR" 'standalone review'; then
    exit 2
  fi
  lock_owned=1
fi

review_tmp=""
cleanup() {
  agent_stop_active_process
  if [[ -n "$review_tmp" ]]; then
    rm -f -- "$review_tmp"
  fi
  if (( lock_owned == 1 )); then
    agent_release_lock "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

preflight_args=(
  --review-only
  --reviewer-agent "$reviewer_agent"
  --reviewer-model "$reviewer_model"
  --reviewer-effort "$reviewer_effort"
)
if [[ -n "$max_rounds_override" ]]; then
  preflight_args+=(--max-rounds "$max_rounds_override")
fi
if ! "$ROOT_DIR/scripts/agent-preflight.sh" "${preflight_args[@]}"; then
  printf 'REVIEWER was not started because preflight failed.\n' >&2
  exit 6
fi

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_status" ]]; then
  printf 'Refusing formal review because the Git working tree is not clean.\n' >&2
  printf '%s\n' "$dirty_status" >&2
  printf 'Resolve the changes yourself; this script will not modify them.\n' >&2
  exit 2
fi

if [[ ! -x "$runner" ]]; then
  printf 'Executor adapter is missing or not executable: %s\n' "$runner" >&2
  exit 127
fi

agent_runtime_prepare_npm_cache || exit 2

target_input="${positional[0]:-HEAD}"
if ! target_commit="$(git -C "$ROOT_DIR" rev-parse --verify "$target_input^{commit}" 2>/dev/null)"; then
  printf 'Target is not a valid commit: %s\n' "$target_input" >&2
  exit 2
fi

head_commit="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
if [[ "$target_commit" != "$head_commit" ]]; then
  printf 'Target must be checked-out HEAD so validation matches the reviewed code.\n' >&2
  printf 'HEAD:   %s\nTarget: %s\n' "$head_commit" "$target_commit" >&2
  exit 2
fi

if [[ -n "${positional[1]:-}" ]]; then
  base_input="${positional[1]}"
  if ! base_commit="$(git -C "$ROOT_DIR" rev-parse --verify "$base_input^{commit}" 2>/dev/null)"; then
    printf 'Base is not a valid commit: %s\n' "$base_input" >&2
    exit 2
  fi
elif git -C "$ROOT_DIR" rev-parse --verify "$target_commit^" >/dev/null 2>&1; then
  base_commit="$(git -C "$ROOT_DIR" rev-parse --verify "$target_commit^")"
else
  base_commit="$(git -C "$ROOT_DIR" hash-object -t tree /dev/null)"
fi

current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
configured_max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_reviewed_commit="$(sed -n 's/^LAST_REVIEWED_COMMIT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_verdict="$(sed -n 's/^LAST_REVIEW_VERDICT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
active_task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
active_task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_implementer_agent="$(sed -n 's/^LAST_IMPLEMENTER_AGENT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_implementer_model="$(sed -n 's/^LAST_IMPLEMENTER_MODEL=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_implementer_effort="$(sed -n 's/^LAST_IMPLEMENTER_EFFORT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"

[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$configured_max_rounds" =~ ^[1-9][0-9]*$ ]] || configured_max_rounds=3
max_rounds="${max_rounds_override:-$configured_max_rounds}"

if [[ "$last_verdict" == "PASS" && -n "$last_reviewed_commit" && \
      "$target_commit" != "$last_reviewed_commit" ]]; then
  current_round=0
fi
if (( current_round >= max_rounds )); then
  printf 'Maximum review rounds reached (%s). Ask the project owner how to proceed.\n' "$max_rounds" >&2
  exit 3
fi
next_round=$((current_round + 1))

if "$ROOT_DIR/scripts/run-validation.sh"; then
  validation_status="PASS"
  validation_exit=0
else
  validation_exit=$?
  validation_status="FAIL"
  printf 'Validation failed (exit %s); REVIEWER will report the evidence.\n' "$validation_exit" >&2
fi

review_tmp="$(mktemp /tmp/vicious-review.XXXXXX.md)"
run_id="review-r${next_round}-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
prompt_file="$ARTIFACT_DIR/prompt-round-${next_round}.md"
agent_log="$ARTIFACT_DIR/${reviewer_agent}-round-${next_round}.log"
manifest_file="$RUN_DIR/${run_id}.env"
events_file="$ARTIFACT_DIR/${run_id}.events.$([[ "$reviewer_agent" == "codex" ]] && printf jsonl || printf json)"
usage_file="$ARTIFACT_DIR/${run_id}.usage.json"

agent_prepare_role_session \
  "$active_task_id" REVIEWER "$reviewer_agent" "$reviewer_model" "$reviewer_effort"

agent_write_run_manifest \
  "$manifest_file" "$run_id" "$active_task_id" "$next_round" \
  REVIEWER "$reviewer_agent" "$reviewer_model" "$reviewer_effort" \
  read-only "$reviewer_timeout" "$base_commit" "$target_commit" \
  .agent/latest-review.md
agent_append_run_session \
  "$manifest_file" "$AGENT_SESSION_ID" "$AGENT_SESSION_MODE" \
  "${events_file#"$ROOT_DIR/"}" "${usage_file#"$ROOT_DIR/"}"
agent_append_run_limits \
  "$manifest_file" "$claude_max_turns" "$claude_max_budget_usd" \
  "$claude_context_rotate_tokens"

if [[ -n "$AGENT_SESSION_ROTATED_FROM" ]]; then
  context_instructions="This is a deliberately compacted continuation of the
same task-scoped REVIEWER role. The previous raw session
$AGENT_SESSION_ROTATED_FROM exceeded the context guard. Reconstruct only the
review working set from the exact base/target diff, current implementation
report, validation evidence, prior formal findings and directly relevant
specification/code sections. Never request the IMPLEMENTER conversation."
elif [[ "$AGENT_SESSION_MODE" == "resume" ]]; then
  context_instructions="This is a continuation of the same task-scoped REVIEWER conversation.
Do not inherit or request the IMPLEMENTER conversation. Re-read the exact base
and target diff, current implementation report, validation evidence and prior
formal findings. Re-open only changed or directly relevant specification and
code sections, and independently revalidate every finding against the new
target."
else
  context_instructions="Read PROJECT.md, AGENT_PROTOCOL.md,
.agent/roles/REVIEWER.md, PROJECT_SPEC.md,
docs/engineering/SOURCE_SCENE.md, docs/engineering/REACTOR_POOL_SYSTEM.md,
docs/engineering/REACTOR_MODEL.md, REVIEW_CONTRACT.md, README.md,
.agent/implementation-report.md, the specified Git diff, related code/tests,
and validation evidence."
fi

cat >"$prompt_file" <<EOF
You are one bounded Agent invocation with the explicitly assigned role REVIEWER,
not IMPLEMENTER. Your executor is $reviewer_agent, model is $reviewer_model, and
effort is $reviewer_effort. Do not infer a role from the executor name, switch
roles, edit repository files, or start another Agent. The review profile is
read-only. This role session never contains IMPLEMENTER invocations.

Task: $active_task_id
Round: $next_round of at most $max_rounds
Review target: $target_commit
Compare against: $base_commit
Working tree at launch: clean
Validation: $validation_status (exit $validation_exit)
Validation summary: .agent/artifacts/validation/summary.md
Role session: ${AGENT_SESSION_ID:-pending} ($AGENT_SESSION_MODE)
Session generation: $AGENT_SESSION_GENERATION
Run manifest: ${manifest_file#"$ROOT_DIR/"}

$context_instructions

Check scope compliance, bugs, regressions, test adequacy, responsive behavior,
main flows, and console errors. For SOURCE changes, verify first-interaction
activation, continuous operation, session reset, cross-system causality, grating,
water, glass damage/fracture, audio, and locked decisions. For reactor-pool
changes, verify RP-* structures and connections, pulse preconditions and timing,
mechanical/water/thermal load paths, equilibrium, source/proxy labels,
approximations, and gap closure. Use Playwright MCP at required viewports for
page changes when safely available; otherwise record exactly what is unverified.

Do not introduce requirements outside PROJECT_SPEC.md. Every finding must have
evidence, impact, reproduction, expected/actual behavior, and objective acceptance
criteria. Minor and Suggestion items do not block passing.

Output only the complete Markdown report specified by REVIEW_CONTRACT.md, in
Simplified Chinese except identifiers, commands, paths, and VERDICT values.
The first heading must be "# Agent Review". Under "## Review metadata", include
exactly this line:
- Reviewer runtime: $reviewer_agent / $reviewer_model / $reviewer_effort
Keep all required sections and exactly one standalone VERDICT: PASS or
VERDICT: CHANGES_REQUIRED line. Do not wrap the report in a code fence.
EOF

printf 'Starting REVIEWER round %s/%s\n' "$next_round" "$max_rounds"
printf 'Runtime: %s / %s / %s\n' "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
printf 'Role session: %s (%s)\n' "${AGENT_SESSION_ID:-assigned-by-executor}" "$AGENT_SESSION_MODE"
if [[ "$reviewer_agent" == "claude" ]]; then
  printf 'Claude guard: max %s turns / $%s API-equivalent / rotate at %s cached tokens\n' \
    "$claude_max_turns" "$claude_max_budget_usd" "$claude_context_rotate_tokens"
fi
export AGENT_SESSION_ID AGENT_SESSION_MODE AGENT_SESSION_GENERATION
export AGENT_CLAUDE_MAX_TURNS="$claude_max_turns"
export AGENT_CLAUDE_MAX_BUDGET_USD="$claude_max_budget_usd"
export AGENT_EVENT_FILE="$events_file"
run_agent_process \
  "REVIEWER ($reviewer_agent) round $next_round/$max_rounds" \
  "$reviewer_timeout" "$heartbeat_seconds" "$termination_grace" "$agent_log" -- \
  "$runner" REVIEWER "$reviewer_model" "$reviewer_effort" "$prompt_file" "$review_tmp"
reviewer_exit=$?
unset AGENT_EVENT_FILE AGENT_CLAUDE_MAX_TURNS AGENT_CLAUDE_MAX_BUDGET_USD

if (( reviewer_exit == 0 )); then
  run_status="SUCCESS"
else
  run_status="$AGENT_RUN_REASON"
fi
agent_finalize_role_session "$reviewer_agent" "$events_file" "$run_status"
agent_record_telemetry "$reviewer_agent" "$events_file" "$usage_file"
session_rotation="NO"
if agent_mark_role_session_rotation \
  "$reviewer_agent" "$usage_file" "${claude_context_rotate_tokens:-1000000}"; then
  session_rotation="REQUIRED"
fi
printf 'RESOLVED_SESSION_ID=%s\n' "$AGENT_SESSION_ID" >>"$manifest_file"
printf 'SESSION_ROTATION_REQUIRED=%s\n' "$session_rotation" >>"$manifest_file"
agent_finish_run_manifest \
  "$manifest_file" "$run_status" "$reviewer_exit" "$AGENT_RUN_REASON"

if (( reviewer_exit != 0 )); then
  agent_record_stop REVIEWER "$AGENT_RUN_REASON" "$reviewer_exit" "$agent_log"
  {
    printf 'BASE_COMMIT=%s\n' "$base_commit"
    printf 'TARGET_COMMIT=%s\n' "$target_commit"
  } >>"$AGENT_DIR/artifacts/runtime/last-stop.env"
  printf 'REVIEWER stopped (exit %s, reason %s). Previous review was preserved.\n' \
    "$reviewer_exit" "$AGENT_RUN_REASON" >&2
  printf 'Log: %s\n' "$agent_log" >&2
  exit "$reviewer_exit"
fi

if [[ ! -s "$review_tmp" ]]; then
  printf 'REVIEWER produced no final report. Previous review was preserved.\n' >&2
  exit 4
fi
if ! grep -Fqx '# Agent Review' "$review_tmp"; then
  printf 'Review report does not use the required title.\n' >&2
  install -m 0644 "$review_tmp" "$ARTIFACT_DIR/candidate-invalid.md"
  exit 4
fi
if ! grep -Fqx -- "- Reviewer runtime: $reviewer_agent / $reviewer_model / $reviewer_effort" \
  "$review_tmp"; then
  printf 'Review report does not record the assigned runtime.\n' >&2
  install -m 0644 "$review_tmp" "$ARTIFACT_DIR/candidate-invalid.md"
  exit 4
fi

verdict_count="$(grep -Ec '^VERDICT: (PASS|CHANGES_REQUIRED)$' "$review_tmp" || true)"
if [[ "$verdict_count" != "1" ]]; then
  printf 'Review report does not contain exactly one valid VERDICT.\n' >&2
  install -m 0644 "$review_tmp" "$ARTIFACT_DIR/candidate-invalid.md"
  exit 4
fi

required_sections=(
  "## Review metadata"
  "## Executive summary"
  "## Blocker"
  "## Major"
  "## Minor"
  "## Suggestions"
  "## Validation results"
  "## Confirmed working"
  "## Unverified areas"
  "## Required next actions"
)
for section in "${required_sections[@]}"; do
  if ! grep -Fqx "$section" "$review_tmp"; then
    printf 'Review report is missing required section: %s\n' "$section" >&2
    install -m 0644 "$review_tmp" "$ARTIFACT_DIR/candidate-invalid.md"
    exit 4
  fi
done

verdict="$(sed -n 's/^VERDICT: //p' "$review_tmp")"
if [[ "$verdict" == "PASS" ]]; then
  active_task_status="COMPLETE"
else
  active_task_status="NEEDS_CHANGES"
fi
short_commit="$(git -C "$ROOT_DIR" rev-parse --short=12 "$target_commit")"
archive_name="$(date -u +"%Y-%m-%d")_round-$(printf '%02d' "$next_round")_${short_commit}.md"
archive_path="$HISTORY_DIR/$archive_name"
if [[ -e "$archive_path" ]]; then
  printf 'Archive already exists; refusing to overwrite: %s\n' "$archive_path" >&2
  exit 4
fi

install -m 0644 "$review_tmp" "$LATEST_REVIEW"
install -m 0644 "$review_tmp" "$archive_path"

state_tmp="$AGENT_DIR/state.env.tmp"
{
  printf 'CURRENT_ROUND=%s\n' "$next_round"
  printf 'ACTIVE_TASK_ID=%s\n' "$active_task_id"
  printf 'ACTIVE_TASK_STATUS=%s\n' "$active_task_status"
  printf 'LAST_IMPLEMENTATION_COMMIT=%s\n' "$target_commit"
  printf 'LAST_REVIEWED_COMMIT=%s\n' "$target_commit"
  printf 'LAST_REVIEW_VERDICT=%s\n' "$verdict"
  printf 'LAST_VALIDATION_STATUS=%s\n' "$validation_status"
  printf 'MAX_ROUNDS=%s\n' "$configured_max_rounds"
  printf 'LAST_IMPLEMENTER_AGENT=%s\n' "$last_implementer_agent"
  printf 'LAST_IMPLEMENTER_MODEL=%s\n' "$last_implementer_model"
  printf 'LAST_IMPLEMENTER_EFFORT=%s\n' "$last_implementer_effort"
  printf 'LAST_REVIEWER_AGENT=%s\n' "$reviewer_agent"
  printf 'LAST_REVIEWER_MODEL=%s\n' "$reviewer_model"
  printf 'LAST_REVIEWER_EFFORT=%s\n' "$reviewer_effort"
} >"$state_tmp"
mv "$state_tmp" "$STATE_FILE"

agent_clear_stop
printf 'Review complete: %s\n' "$verdict"
printf 'Runtime: %s / %s / %s\n' "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
printf 'Latest report: %s\n' "$LATEST_REVIEW"
printf 'Archive: %s\n' "$archive_path"
