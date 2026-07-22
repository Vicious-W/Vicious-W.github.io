#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
ARTIFACT_DIR="$AGENT_DIR/artifacts/review"
STATE_FILE="$AGENT_DIR/state.env"
LATEST_REVIEW="$AGENT_DIR/latest-review.md"
HISTORY_DIR="$AGENT_DIR/review-history"
LOCK_DIR="$AGENT_DIR/.cycle.lock"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-review.sh [target-commit] [base-commit]

Defaults:
  target-commit  HEAD
  base-commit    target-commit^ (or the empty tree for an initial commit)

The working tree must be completely clean. The script runs validation, launches
one Codex process in a read-only sandbox, validates the final report format, then
updates .agent/latest-review.md and appends a history file.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if (( $# > 2 )); then
  usage >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR" "$HISTORY_DIR"

lock_owned=0
if [[ "${AGENT_CYCLE_LOCK_HELD:-0}" != "1" ]]; then
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'Another Agent workflow appears to be active: %s\n' "$LOCK_DIR" >&2
    exit 2
  fi
  lock_owned=1
fi

review_tmp=""
cleanup() {
  if [[ -n "$review_tmp" ]]; then
    rm -f -- "$review_tmp"
  fi
  if (( lock_owned == 1 )); then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_status" ]]; then
  printf 'Refusing formal review because the Git working tree is not clean.\n' >&2
  printf '%s\n' "$dirty_status" >&2
  printf 'Commit or otherwise resolve the changes yourself; this script will not modify them.\n' >&2
  exit 2
fi

if ! command -v codex >/dev/null 2>&1; then
  printf 'codex CLI is not available on PATH.\n' >&2
  exit 127
fi

target_input="${1:-HEAD}"
if ! target_commit="$(git -C "$ROOT_DIR" rev-parse --verify "$target_input^{commit}" 2>/dev/null)"; then
  printf 'Target is not a valid commit: %s\n' "$target_input" >&2
  exit 2
fi

head_commit="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
if [[ "$target_commit" != "$head_commit" ]]; then
  printf 'Target commit must be the currently checked-out HEAD so validation matches the reviewed code.\n' >&2
  printf 'HEAD:   %s\nTarget: %s\n' "$head_commit" "$target_commit" >&2
  printf 'Use a separate clean worktree if you need to review another commit.\n' >&2
  exit 2
fi

if [[ -n "${2:-}" ]]; then
  base_input="$2"
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
max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_reviewed_commit="$(sed -n 's/^LAST_REVIEWED_COMMIT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
last_verdict="$(sed -n 's/^LAST_REVIEW_VERDICT=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
active_task_id="$(sed -n 's/^ACTIVE_TASK_ID=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"
active_task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" 2>/dev/null | head -n 1)"

[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3

# A commit after a successful review starts a new bounded cycle automatically.
# After CHANGES_REQUIRED the counter intentionally continues across fix commits.
if [[ "$last_verdict" == "PASS" && -n "$last_reviewed_commit" && "$target_commit" != "$last_reviewed_commit" ]]; then
  current_round=0
fi

if (( current_round >= max_rounds )); then
  printf 'Maximum review rounds reached (%s). Stop and ask the project owner how to proceed.\n' "$max_rounds" >&2
  exit 3
fi
next_round=$((current_round + 1))

if "$ROOT_DIR/scripts/run-validation.sh"; then
  validation_status="PASS"
  validation_exit=0
else
  validation_exit=$?
  validation_status="FAIL"
  printf 'Validation failed (exit %s); Codex will review and report the evidence.\n' "$validation_exit" >&2
fi

review_tmp="$(mktemp /tmp/vicious-review.XXXXXX.md)"
prompt_file="$ARTIFACT_DIR/prompt.md"
codex_log="$ARTIFACT_DIR/codex.log"

cat >"$prompt_file" <<EOF
You are the independent Codex reviewer for this repository, not the implementer.
This is one bounded review invocation. Do not edit any repository file and do not
attempt to call Codex recursively. The sandbox is read-only.

Review target commit: $target_commit
Compare against: $base_commit
Working tree at launch: clean
Validation status: $validation_status (exit $validation_exit)
Validation summary: .agent/artifacts/validation/summary.md

Read PROJECT_SPEC.md, REVIEW_CONTRACT.md, AGENTS.md,
.agent/implementation-report.md, the specified Git diff, related code/tests, and
validation evidence. Check scope compliance, bugs, regressions, test adequacy,
responsive behavior, main flows, and console errors. If the change affects page
appearance or behavior, use Playwright MCP (not a Bash Playwright script) at the
required viewports when available; otherwise record exactly what is unverified.

Do not introduce requirements outside PROJECT_SPEC.md. Every finding must have
evidence, impact, reproduction, expected/actual behavior, and objective acceptance
criteria. Minor and Suggestion items do not block passing.

Output only the complete Markdown report matching REVIEW_CONTRACT.md. Include all
required sections and exactly one standalone line containing either
VERDICT: PASS or VERDICT: CHANGES_REQUIRED. Do not wrap the report in a code fence.
EOF

codex exec \
  --cd "$ROOT_DIR" \
  --sandbox read-only \
  --ephemeral \
  --color never \
  -c 'approval_policy="never"' \
  --output-last-message "$review_tmp" \
  - <"$prompt_file" >"$codex_log" 2>&1
codex_exit=$?
if (( codex_exit != 0 )); then
  printf 'Codex review process failed (exit %s). Previous review was preserved.\n' "$codex_exit" >&2
  printf 'Log: %s\n' "$codex_log" >&2
  exit "$codex_exit"
fi

if [[ ! -s "$review_tmp" ]]; then
  printf 'Codex produced no final report. Previous review was preserved.\n' >&2
  exit 4
fi

verdict_count="$(grep -Ec '^VERDICT: (PASS|CHANGES_REQUIRED)$' "$review_tmp" || true)"
if [[ "$verdict_count" != "1" ]]; then
  printf 'Codex report does not contain exactly one valid standalone VERDICT.\n' >&2
  printf 'Candidate report preserved at %s/candidate-invalid.md\n' "$ARTIFACT_DIR" >&2
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
    printf 'Codex report is missing required section: %s\n' "$section" >&2
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
  printf 'MAX_ROUNDS=%s\n' "$max_rounds"
} >"$state_tmp"
mv "$state_tmp" "$STATE_FILE"

printf 'Review complete: %s\n' "$verdict"
printf 'Latest report: %s\n' "$LATEST_REVIEW"
printf 'Archive: %s\n' "$archive_path"
