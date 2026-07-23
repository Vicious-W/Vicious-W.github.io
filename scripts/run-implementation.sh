#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/implementation"
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
Usage: ./scripts/run-implementation.sh

Runs exactly one non-interactive Claude Code implementation round for the active
.agent/next-task.md. The working tree must start clean. Claude may edit the
workspace but may not stage, commit, push, reset, clean, switch branches, or
deploy. The wrapper validates and creates one local implementation checkpoint.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if (( $# != 0 )); then
  usage >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"

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

if ! "$ROOT_DIR/scripts/agent-preflight.sh" --implementation-only; then
  printf 'Claude was not started because preflight failed.\n' >&2
  exit 6
fi

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_status" ]]; then
  printf 'Refusing Claude implementation because the Git working tree is not clean.\n' >&2
  printf '%s\n' "$dirty_status" >&2
  printf 'Create a safe checkpoint first; this script will not discard or absorb pre-existing changes.\n' >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  printf 'claude CLI is not available on PATH.\n' >&2
  exit 127
fi

claude_timeout="$(agent_runtime_config CLAUDE_TIMEOUT_SECONDS 7200 60 43200)" || exit 2
heartbeat_seconds="$(agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300)" || exit 2
termination_grace="$(agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60)" || exit 2
claude_model="$(agent_runtime_model_config CLAUDE_MODEL sonnet)" || exit 2
claude_effort="$(agent_runtime_effort_config CLAUDE_EFFORT high)" || exit 2
agent_runtime_prepare_npm_cache || exit 2

if [[ ! -s "$TASK_FILE" ]]; then
  printf 'Active task file is missing or empty: %s\n' "$TASK_FILE" >&2
  exit 2
fi

active_task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$STATE_FILE" | head -n 1)"
active_task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" | head -n 1)"
current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" | head -n 1)"
max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" | head -n 1)"

[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3

if [[ -z "$active_task_id" ]]; then
  printf 'ACTIVE_TASK_ID is empty in %s.\n' "$STATE_FILE" >&2
  exit 2
fi
if [[ "$active_task_status" != "READY" && "$active_task_status" != "NEEDS_CHANGES" ]]; then
  printf 'Active task is not ready for implementation: %s\n' "$active_task_status" >&2
  exit 3
fi
if (( current_round >= max_rounds )); then
  printf 'Maximum review rounds reached (%s). Stop and return control to the project owner.\n' "$max_rounds" >&2
  exit 3
fi

implementation_round=$((current_round + 1))
base_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
base_git_config="$(git -C "$ROOT_DIR" config --local --list --show-origin 2>/dev/null)"
base_git_refs="$(git -C "$ROOT_DIR" show-ref 2>/dev/null || true)"
prompt_file="$ARTIFACT_DIR/prompt-round-${implementation_round}.md"
claude_log="$ARTIFACT_DIR/claude-round-${implementation_round}.log"

cat >"$prompt_file" <<EOF
You are Claude Code, the sole implementation Agent for this repository. Execute
exactly one bounded implementation round for task $active_task_id (round
$implementation_round of at most $max_rounds).

Read, in order: PROJECT_SPEC.md, CLAUDE.md, REVIEW_CONTRACT.md,
.agent/next-task.md, .agent/latest-review.md, .agent/implementation-report.md,
PROJECT.md, the current Git status, and all directly relevant code.

Implement the active task comprehensively. If the latest Codex verdict is
CHANGES_REQUIRED, address every valid Blocker and Major first. Make reasonable
technical decisions within the owner's approved scope; do not invent unrelated
features. For reactor accuracy, research public authoritative sources and record
the selected archetype, URLs, modeling choices, and deliberate abstractions in
PROJECT.md and .agent/implementation-report.md.

You may edit source, styles, tests, package configuration, and project progress
documentation. The collaboration control plane is protected: do not modify
PROJECT_SPEC.md, REVIEW_CONTRACT.md, AGENTS.md, CLAUDE.md, .gitignore,
.claude/, .codex/, any .agent/ file other than implementation-report.md and
ignored artifacts, or Agent/validation control scripts. Do not stage or commit:
the outer wrapper creates the Git checkpoint after validation. Never push,
deploy, reset, clean, rebase, switch branches, delete owner files, inspect secret
stores, or expose credentials.

Run ./scripts/run-validation.sh. Because this task changes page appearance and
behavior, start/reuse the local Vite preview and use Playwright MCP—not a Bash
Playwright script—to exercise the required desktop, tablet, and mobile viewports,
glass dragging/stacking/audio activation, reactor behavior, responsive layout, and
browser console. Preserve evidence in ignored .agent/artifacts paths when useful.

Before finishing, replace .agent/implementation-report.md with a complete report
matching its documented format and update PROJECT.md sections 5 and 7. Report
passes, failures, NOT CONFIGURED items, unverified areas, remaining risks, and the
exact handoff focus for Codex. Then stop. Do not merely describe a plan: implement
and verify as much of the approved task as can be completed safely in this round.

Base commit at launch: $base_commit
EOF

printf 'Starting Claude Code implementation round %s/%s for %s\n' "$implementation_round" "$max_rounds" "$active_task_id"
printf 'Claude model policy: %s (effort %s)\n' "$claude_model" "$claude_effort"

prompt_text="$(<"$prompt_file")"
run_agent_process \
  "Claude implementation round $implementation_round/$max_rounds" \
  "$claude_timeout" "$heartbeat_seconds" "$termination_grace" "$claude_log" -- \
  claude --print \
    --model "$claude_model" \
    --effort "$claude_effort" \
    --permission-mode dontAsk \
    --no-session-persistence \
    --output-format text \
    --allowedTools "Read(./**),Edit(./**),Glob,Grep,Bash(./scripts/run-validation.sh),Bash(npm run *),Bash(npm install *),Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git ls-files *),Bash(rg *),Bash(find *),Bash(sed *),Bash(ls *),Bash(curl http://localhost:*),Bash(curl http://127.0.0.1:*),WebSearch,WebFetch,mcp__playwright__*" \
    --disallowedTools "Bash(git add *),Bash(git commit *),Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(git checkout *),Bash(git switch *),Bash(git rebase *),Bash(git rm *),Bash(rm -rf *),Bash(sudo *),Bash(env),Bash(printenv *),Task,Agent" \
    -- "$prompt_text"
claude_exit=$?

if (( claude_exit != 0 )); then
  agent_record_stop CLAUDE "$AGENT_RUN_REASON" "$claude_exit" "$claude_log"
  printf 'Claude Code stopped (exit %s, reason %s). Changes, if any, were left untouched for inspection.\n' \
    "$claude_exit" "$AGENT_RUN_REASON" >&2
  printf 'Log: %s\n' "$claude_log" >&2
  exit "$claude_exit"
fi

if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$base_commit" ]]; then
  agent_record_stop CLAUDE GIT_HISTORY_CHANGED 4 "$claude_log"
  printf 'Claude changed Git history despite the boundary. Stopping without further mutation.\n' >&2
  exit 4
fi
current_git_config="$(git -C "$ROOT_DIR" config --local --list --show-origin 2>/dev/null)"
current_git_refs="$(git -C "$ROOT_DIR" show-ref 2>/dev/null || true)"
if [[ "$current_git_config" != "$base_git_config" || "$current_git_refs" != "$base_git_refs" ]]; then
  agent_record_stop CLAUDE GIT_CONTROL_PLANE_CHANGED 4 "$claude_log"
  printf 'Claude changed local Git configuration or refs. Stopping without staging.\n' >&2
  exit 4
fi
if ! git -C "$ROOT_DIR" diff --cached --quiet --; then
  agent_record_stop CLAUDE PRESTAGED_CHANGES 4 "$claude_log"
  printf 'Claude staged changes despite the boundary. Stopping without altering the index.\n' >&2
  exit 4
fi

is_protected_implementation_path() {
  case "$1" in
    PROJECT_SPEC.md|REVIEW_CONTRACT.md|AGENTS.md|CLAUDE.md|.gitignore) return 0 ;;
    .claude/*|.codex/*) return 0 ;;
    .agent/implementation-report.md|.agent/artifacts/*) return 1 ;;
    .agent/*) return 0 ;;
    scripts/agent-*.sh|scripts/generate-cycle-summary.sh|scripts/run-implementation.sh|scripts/run-review.sh|scripts/run-validation.sh|scripts/test-agent-runtime.sh|scripts/lib/agent-runtime.sh) return 0 ;;
    *) return 1 ;;
  esac
}

protected_violation=0
while IFS= read -r -d '' changed_path; do
  [[ -n "$changed_path" ]] || continue
  if is_protected_implementation_path "$changed_path"; then
    printf 'Claude modified protected control-plane file: %s\n' "$changed_path" >&2
    protected_violation=1
  fi
done < <(
  git -C "$ROOT_DIR" diff --name-only -z --
  git -C "$ROOT_DIR" ls-files --others --exclude-standard -z
)
if (( protected_violation != 0 )); then
  agent_record_stop CLAUDE POLICY_VIOLATION 4 "$claude_log"
  printf 'Stopping before validation or staging. Protected changes were left untouched for owner inspection.\n' >&2
  exit 4
fi

implementation_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -z "$implementation_status" ]]; then
  agent_record_stop CLAUDE NO_REPOSITORY_CHANGES 5 "$claude_log"
  printf 'Claude completed without producing any repository changes. No checkpoint created.\n' >&2
  exit 5
fi

if git -C "$ROOT_DIR" diff --quiet -- "$REPORT_FILE" || \
   grep -Fq 'IMPLEMENTATION_STATUS: NOT_REPORTED' "$REPORT_FILE"; then
  agent_record_stop CLAUDE IMPLEMENTATION_REPORT_MISSING 5 "$claude_log"
  printf 'Claude did not replace the implementation report. Changes were left uncommitted.\n' >&2
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
  printf -- '- Claude process: PASS (exit 0)\n'
  printf -- '- Unified validation: %s (exit %s)\n' "$validation_status" "$validation_exit"
  printf -- '- Checkpoint: created by `scripts/run-implementation.sh` after this report\n'
} >>"$REPORT_FILE"

if ! git -C "$ROOT_DIR" add --all; then
  agent_record_stop WRAPPER CHECKPOINT_PERMISSION 4 "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log"
  printf 'Could not stage the implementation checkpoint. Changes were preserved.\n' >&2
  exit 4
fi
if git -C "$ROOT_DIR" diff --cached --quiet; then
  printf 'No staged changes remained after implementation.\n' >&2
  exit 5
fi

commit_message="agent: implementation round $implementation_round"
git -C "$ROOT_DIR" \
  -c core.hooksPath=/dev/null \
  -c commit.gpgSign=false \
  commit -m "$commit_message" \
  >"$ARTIFACT_DIR/git-commit-round-${implementation_round}.log" 2>&1
commit_exit=$?
if (( commit_exit != 0 )); then
  commit_reason="$(agent_classify_log "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log")"
  agent_record_stop WRAPPER "$commit_reason" "$commit_exit" "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log"
  printf 'Could not create implementation checkpoint (exit %s). Staged changes were preserved.\n' "$commit_exit" >&2
  printf 'Log: %s\n' "$ARTIFACT_DIR/git-commit-round-${implementation_round}.log" >&2
  exit "$commit_exit"
fi

result_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]]; then
  printf 'Implementation checkpoint was created but the working tree is not clean. Stopping.\n' >&2
  git -C "$ROOT_DIR" status --short >&2
  exit 4
fi

agent_clear_stop
printf 'Claude implementation checkpoint: %s\n' "$result_commit"
printf 'Unified validation before checkpoint: %s\n' "$validation_status"
printf 'Claude log: %s\n' "$claude_log"
