#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/.agent/state.env"
SUMMARY_DIR="$ROOT_DIR/.agent/artifacts/preflight"
SUMMARY_FILE="$SUMMARY_DIR/summary.md"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"

check_implementation=1
check_review=1
allow_dirty=0
skip_git_write=0
skip_external=0

usage() {
  cat <<'EOF'
Usage: ./scripts/agent-preflight.sh [options]

Checks the repository, CLI authentication, Playwright MCP registration/health,
project permission policy, runtime limits, and local checkpoint capability. It
does not start Claude or Codex.

Options:
  --implementation-only  Check only requirements needed by Claude.
  --review-only          Check only requirements needed by Codex.
  --allow-dirty          Diagnostic mode: do not fail on a dirty worktree.
  --skip-git-write       Diagnostic mode: do not probe .git write access.
  --skip-external        Diagnostic mode: skip auth and MCP CLI checks.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --implementation-only)
      check_implementation=1
      check_review=0
      ;;
    --review-only)
      check_implementation=0
      check_review=1
      ;;
    --allow-dirty) allow_dirty=1 ;;
    --skip-git-write) skip_git_write=1 ;;
    --skip-external) skip_external=1 ;;
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
  shift
done

mkdir -p "$SUMMARY_DIR"
: >"$SUMMARY_FILE"
failure_count=0

record_pass() {
  printf 'PASS  %s\n' "$1"
  printf -- '- PASS: %s\n' "$1" >>"$SUMMARY_FILE"
}

record_fail() {
  printf 'FAIL  %s\n' "$1" >&2
  printf -- '- FAIL: %s\n' "$1" >>"$SUMMARY_FILE"
  failure_count=$((failure_count + 1))
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    record_pass "command available: $1"
  else
    record_fail "command missing: $1"
  fi
}

run_private_check() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp /tmp/agent-preflight.XXXXXX)"
  if timeout 45 "$@" >"$output_file" 2>&1; then
    rm -f -- "$output_file"
    record_pass "$label"
    return 0
  fi
  rm -f -- "$output_file"
  record_fail "$label"
  return 1
}

check_mcp() {
  local owner="$1"
  shift
  local output_file
  output_file="$(mktemp /tmp/agent-preflight-mcp.XXXXXX)"
  if ! timeout 60 "$@" >"$output_file" 2>&1; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP status command failed or timed out"
    return
  fi
  if ! grep -Eiq 'playwright' "$output_file"; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP is not registered"
    return
  fi
  if grep -Eiq 'playwright[^[:cntrl:]]*(failed|error|unhealthy|disconnected|could not connect|disabled)' "$output_file"; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP is registered but not healthy"
    return
  fi
  rm -f -- "$output_file"
  record_pass "$owner Playwright MCP is registered and reports healthy/enabled"
}

{
  printf '# Agent preflight summary\n\n'
  printf -- '- Checked at: `%s`\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- Implementation checks: `%s`\n' "$check_implementation"
  printf -- '- Review checks: `%s`\n\n' "$check_review"
  printf '## Results\n\n'
} >"$SUMMARY_FILE"

for command_name in git node npm rg sed grep timeout setsid mktemp; do
  check_command "$command_name"
done
if (( check_implementation == 1 )); then check_command claude; fi
if (( check_review == 1 )); then check_command codex; fi

required_files=(
  PROJECT_SPEC.md
  AGENTS.md
  CLAUDE.md
  REVIEW_CONTRACT.md
  PROJECT.md
  .agent/next-task.md
  .agent/state.env
  .agent/runtime.env
  .claude/settings.json
  scripts/agent-preflight.sh
  scripts/run-validation.sh
  scripts/lib/agent-runtime.sh
  scripts/test-agent-runtime.sh
)
for relative_path in "${required_files[@]}"; do
  if [[ -s "$ROOT_DIR/$relative_path" ]]; then
    record_pass "required file: $relative_path"
  else
    record_fail "missing or empty required file: $relative_path"
  fi
done

if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "$ROOT_DIR/.claude/settings.json" >/dev/null 2>&1; then
  record_pass '.claude/settings.json is valid JSON'
else
  record_fail '.claude/settings.json is missing or invalid JSON'
fi

if rg -n '"defaultMode"[[:space:]]*:[[:space:]]*"bypassPermissions"' \
  "$ROOT_DIR/.claude/settings.json" "$ROOT_DIR/.claude/settings.local.json" \
  >/dev/null 2>&1; then
  record_fail 'Claude project settings contain forbidden bypassPermissions mode'
else
  record_pass 'Claude project settings do not bypass permissions'
fi

if node - "$ROOT_DIR/.claude/settings.json" "$ROOT_DIR/.claude/settings.local.json" <<'NODE'
const fs = require('fs');
for (const path of process.argv.slice(2)) {
  if (!fs.existsSync(path)) continue;
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (settings.permissions?.defaultMode !== 'dontAsk') process.exit(1);
}
NODE
then
  record_pass 'Claude project settings use non-interactive dontAsk mode'
else
  record_fail 'Claude project settings are not locked to dontAsk mode'
fi

if node - "$ROOT_DIR/.claude/settings.json" "$ROOT_DIR/.claude/settings.local.json" <<'NODE'
const fs = require('fs');
const forbidden = /^Bash\(git (add|commit|push|reset|clean|checkout|switch|rebase|rm)\b|^Bash\(sudo\b|^Bash\(env\)|^Bash\(printenv\b/;
for (const path of process.argv.slice(2)) {
  if (!fs.existsSync(path)) continue;
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
  const allowed = settings.permissions?.allow ?? [];
  if (allowed.some((rule) => forbidden.test(rule))) process.exit(1);
}
NODE
then
  record_pass 'Claude allowlists do not grant Git control, sudo, or environment dumps'
else
  record_fail 'Claude allowlists grant a forbidden Git/system capability'
fi

if node - "$ROOT_DIR/.claude/settings.json" <<'NODE'
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const denied = new Set(settings.permissions?.deny ?? []);
const required = [
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git push *)',
  'Bash(git reset *)',
  'Bash(git clean *)',
  'Bash(git checkout *)',
  'Bash(git switch *)',
  'Bash(git rebase *)',
  'Bash(git rm *)',
  'Task',
  'Agent',
  'Edit(./.git/**)',
  'Write(./.git/**)'
];
if (required.some((rule) => !denied.has(rule))) process.exit(1);
NODE
then
  record_pass 'Claude project policy contains all required Git denials'
else
  record_fail 'Claude project policy is missing one or more required Git denials'
fi

if [[ -x "$ROOT_DIR/scripts/run-validation.sh" && \
      -x "$ROOT_DIR/scripts/agent-preflight.sh" && \
      -x "$ROOT_DIR/scripts/run-implementation.sh" && \
      -x "$ROOT_DIR/scripts/run-review.sh" && \
      -x "$ROOT_DIR/scripts/agent-cycle.sh" && \
      -x "$ROOT_DIR/scripts/test-agent-runtime.sh" ]]; then
  record_pass 'Agent entry scripts are executable'
else
  record_fail 'one or more Agent entry scripts are not executable'
fi

if bash -n "$ROOT_DIR/scripts/agent-preflight.sh" \
  "$ROOT_DIR/scripts/lib/agent-runtime.sh" \
  "$ROOT_DIR/scripts/test-agent-runtime.sh" \
  "$ROOT_DIR/scripts/run-implementation.sh" \
  "$ROOT_DIR/scripts/run-review.sh" \
  "$ROOT_DIR/scripts/agent-cycle.sh"; then
  record_pass 'Agent shell scripts pass bash -n'
else
  record_fail 'Agent shell script syntax check failed'
fi

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"
if agent_runtime_prepare_npm_cache; then
  record_pass 'dedicated Agent npm cache is writable'
else
  record_fail 'dedicated Agent npm cache is not writable'
fi
runtime_values_ok=1
agent_runtime_config CLAUDE_TIMEOUT_SECONDS 7200 60 43200 >/dev/null || runtime_values_ok=0
agent_runtime_config CODEX_TIMEOUT_SECONDS 3600 60 43200 >/dev/null || runtime_values_ok=0
agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300 >/dev/null || runtime_values_ok=0
agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60 >/dev/null || runtime_values_ok=0
if (( runtime_values_ok == 1 )); then
  record_pass '.agent/runtime.env values are within safe bounds'
else
  record_fail '.agent/runtime.env contains invalid values'
fi

current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" | head -n 1)"
max_rounds="$(sed -n 's/^MAX_ROUNDS=//p' "$STATE_FILE" | head -n 1)"
task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" | head -n 1)"
if [[ "$current_round" =~ ^[0-9]+$ && "$max_rounds" =~ ^[1-9][0-9]*$ ]] && \
   (( current_round < max_rounds )) && \
   [[ "$task_status" == "READY" || "$task_status" == "NEEDS_CHANGES" ]]; then
  record_pass "active task can run: status=$task_status, round=$current_round/$max_rounds"
else
  record_fail "active task cannot run: status=$task_status, round=$current_round/$max_rounds"
fi

dirty_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all 2>/dev/null)"
if [[ -z "$dirty_status" ]]; then
  record_pass 'Git working tree is clean'
elif (( allow_dirty == 1 )); then
  record_pass 'Git working tree check was relaxed for diagnostics'
else
  record_fail 'Git working tree is not clean'
fi

if [[ -n "$(git -C "$ROOT_DIR" config user.name 2>/dev/null)" && \
      -n "$(git -C "$ROOT_DIR" config user.email 2>/dev/null)" ]]; then
  record_pass 'Git checkpoint identity is configured'
else
  record_fail 'Git user.name or user.email is not configured'
fi

if (( skip_git_write == 1 )); then
  record_pass '.git write probe skipped for diagnostics'
else
  git_probe="$ROOT_DIR/.git/.agent-preflight-write.$$"
  if (umask 077 && : >"$git_probe") 2>/dev/null; then
    rm -f -- "$git_probe"
    record_pass '.git is writable for local checkpoints'
  else
    rm -f -- "$git_probe" 2>/dev/null || true
    record_fail '.git is not writable; the wrapper cannot create local checkpoints'
  fi
fi

if npm --prefix "$ROOT_DIR" ls --depth=0 >/dev/null 2>&1; then
  record_pass 'installed npm dependencies are internally consistent'
else
  record_fail 'npm dependencies are missing or inconsistent; run npm install'
fi

if (( skip_external == 1 )); then
  record_pass 'CLI authentication and MCP checks skipped for diagnostics'
else
  if (( check_implementation == 1 )); then
    run_private_check 'Claude authentication is available' claude auth status || true
    check_mcp Claude claude mcp list
  fi
  if (( check_review == 1 )); then
    run_private_check 'Codex authentication is available' codex login status || true
    check_mcp Codex codex mcp list
  fi
fi

{
  printf '\n## Verdict\n\n'
  if (( failure_count == 0 )); then
    printf 'PREFLIGHT: PASS\n'
  else
    printf 'PREFLIGHT: FAIL (%s failed checks)\n' "$failure_count"
  fi
} >>"$SUMMARY_FILE"

if (( failure_count != 0 )); then
  printf '\nPreflight failed with %s issue(s). No Agent was started.\n' "$failure_count" >&2
  printf 'Summary: %s\n' "$SUMMARY_FILE" >&2
  exit 6
fi

printf '\nPreflight passed. No Agent was started.\n'
printf 'Summary: %s\n' "$SUMMARY_FILE"
