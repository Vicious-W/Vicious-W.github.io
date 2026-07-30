#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT_DIR/.agent/state.env"
SUMMARY_DIR="$ROOT_DIR/.agent/artifacts/preflight"
SUMMARY_FILE="$SUMMARY_DIR/summary.md"
RUNTIME_LIB="$ROOT_DIR/scripts/lib/agent-runtime.sh"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$RUNTIME_LIB"
agent_runtime_init "$ROOT_DIR"

check_implementation=1
check_review=1
control_only=0
allow_dirty=0
skip_git_write=0
skip_external=0
implementer_agent="$(agent_runtime_executor_config IMPLEMENTER_AGENT claude)" || exit 2
implementer_model="$(agent_runtime_model_config IMPLEMENTER_MODEL sonnet)" || exit 2
implementer_effort="$(agent_runtime_effort_config IMPLEMENTER_EFFORT high)" || exit 2
reviewer_agent="$(agent_runtime_executor_config REVIEWER_AGENT codex)" || exit 2
reviewer_model="$(agent_runtime_model_config REVIEWER_MODEL gpt-5.6-sol)" || exit 2
reviewer_effort="$(agent_runtime_effort_config REVIEWER_EFFORT high)" || exit 2
max_rounds_override=""

usage() {
  cat <<'EOF'
Usage: ./scripts/agent-preflight.sh [options]

Checks repository state, selected executor authentication/MCP, adapter and
permission policy, runtime limits, dependencies and local checkpoint capability.
It never starts an Agent.

Options:
  --implementation-only       Check only the IMPLEMENTER configuration.
  --review-only               Check only the REVIEWER configuration.
  --control-only              Check one read-only GENERAL supervisor-event
                              configuration without task-phase eligibility.
  --implementer-agent NAME    claude or codex.
  --implementer-model MODEL
  --implementer-effort LEVEL
  --reviewer-agent NAME       claude or codex.
  --reviewer-model MODEL
  --reviewer-effort LEVEL
  --max-rounds N             Check this run's absolute implementation target.
  --allow-dirty               Diagnostic: do not fail on dirty worktree.
  --skip-git-write            Diagnostic: do not probe .git write access.
  --skip-external             Diagnostic: skip authentication and MCP checks.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --implementation-only)
      check_implementation=1
      check_review=0
      shift
      ;;
    --review-only)
      check_implementation=0
      check_review=1
      shift
      ;;
    --control-only)
      check_implementation=0
      check_review=1
      control_only=1
      shift
      ;;
    --implementer-agent)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      implementer_agent="$2"
      shift 2
      ;;
    --implementer-model)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      implementer_model="$2"
      shift 2
      ;;
    --implementer-effort)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      implementer_effort="$2"
      shift 2
      ;;
    --reviewer-agent)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      reviewer_agent="$2"
      shift 2
      ;;
    --reviewer-model)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      reviewer_model="$2"
      shift 2
      ;;
    --reviewer-effort)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      reviewer_effort="$2"
      shift 2
      ;;
    --max-rounds)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
      max_rounds_override="$2"
      shift 2
      ;;
    --allow-dirty)
      allow_dirty=1
      shift
      ;;
    --skip-git-write)
      skip_git_write=1
      shift
      ;;
    --skip-external)
      skip_external=1
      shift
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
  if timeout --foreground --kill-after=5s 45s "$@" \
    </dev/null >"$output_file" 2>&1; then
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
  if ! timeout --foreground --kill-after=5s 60s "$@" \
    </dev/null >"$output_file" 2>&1; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP status command failed or timed out"
    return
  fi
  if ! grep -Eiq 'playwright' "$output_file"; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP is not registered"
    return
  fi
  if grep -Eiq 'playwright[^[:cntrl:]]*(failed|error|unhealthy|disconnected|could not connect|disabled)' \
    "$output_file"; then
    rm -f -- "$output_file"
    record_fail "$owner Playwright MCP is registered but not healthy"
    return
  fi
  rm -f -- "$output_file"
  record_pass "$owner Playwright MCP is registered and healthy/enabled"
}

check_executor_external() {
  case "$1" in
    claude)
      run_private_check 'Claude authentication is available' claude auth status || true
      check_mcp Claude claude mcp list
      ;;
    codex)
      run_private_check 'Codex authentication is available' codex login status || true
      check_mcp Codex codex mcp list
      ;;
  esac
}

{
  printf '# Agent preflight summary\n\n'
  printf -- '- Checked at: `%s`\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- Implementation checks: `%s`\n' "$check_implementation"
  printf -- '- Review checks: `%s`\n' \
    "$((control_only == 1 ? 0 : check_review))"
  printf -- '- GENERAL control-event checks: `%s`\n' "$control_only"
  if (( check_implementation == 1 )); then
    printf -- '- IMPLEMENTER: `%s / %s / %s`\n' \
      "$implementer_agent" "$implementer_model" "$implementer_effort"
  fi
  if (( control_only == 1 )); then
    printf -- '- GENERAL supervisor: `%s / %s / %s`\n' \
      "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
  elif (( check_review == 1 )); then
    printf -- '- REVIEWER: `%s / %s / %s`\n' \
      "$reviewer_agent" "$reviewer_model" "$reviewer_effort"
  fi
  printf '\n## Results\n\n'
} >"$SUMMARY_FILE"

for command_name in git node npm rg sed grep timeout setsid mktemp tee; do
  check_command "$command_name"
done

config_ok=1
if (( check_implementation == 1 )); then
  agent_validate_executor "$implementer_agent" || config_ok=0
  agent_validate_model "$implementer_model" || config_ok=0
  agent_validate_effort "$implementer_effort" || config_ok=0
  check_command "$implementer_agent"
fi
if (( check_review == 1 )); then
  agent_validate_executor "$reviewer_agent" || config_ok=0
  agent_validate_model "$reviewer_model" || config_ok=0
  agent_validate_effort "$reviewer_effort" || config_ok=0
  if (( check_implementation == 0 )) || [[ "$reviewer_agent" != "$implementer_agent" ]]; then
    check_command "$reviewer_agent"
  fi
fi
if (( config_ok == 1 )); then
  record_pass 'selected role/executor/model/effort configuration is valid'
else
  record_fail 'selected role/executor/model/effort configuration is invalid'
fi

required_files=(
  README.md
  PROJECT.md
  PROJECT_SPEC.md
  AGENT_PROTOCOL.md
  AGENTS.md
  CLAUDE.md
  REVIEW_CONTRACT.md
  .agent/roles/GENERAL.md
  .agent/roles/IMPLEMENTER.md
  .agent/roles/REVIEWER.md
  docs/engineering/SOURCE_SCENE.md
  docs/engineering/REACTOR_POOL_SYSTEM.md
  docs/engineering/REACTOR_MODEL.md
  docs/engineering/SOURCE_LAB_OPTICS.md
  docs/guides/PROJECT_COMMAND_MANUAL.md
  docs/methodology/AI_Project_Meta_Method_v3.0_2026-07-23.md
  docs/methodology/AI_Project_Meta_Method_v4.0_2026-07-23.md
  docs/methodology/AI_Project_Meta_Method_v5.0_2026-07-24.md
  docs/methodology/AI_Project_Meta_Method_v6.0_2026-07-29.md
  references/README.md
  .vscode/settings.json
  .agent/next-task.md
  .agent/state.env
  .agent/runtime.env
  .claude/settings.json
  .codex/config.toml
  scripts/agent-preflight.sh
  scripts/agent-cycle.sh
  scripts/agent-supervisor.sh
  scripts/agent-runners/claude.sh
  scripts/agent-runners/codex.sh
  scripts/lib/agent-telemetry.mjs
  scripts/lib/agent-usage-ledger.mjs
  scripts/lib/implementation-round-state.sh
  scripts/generate-cycle-summary.sh
  scripts/run-implementation.sh
  scripts/run-monitor.sh
  scripts/run-review.sh
  scripts/run-validation.sh
  scripts/lib/agent-runtime.sh
  scripts/test-agent-runtime.sh
  scripts/test-agent-supervisor.sh
)
for relative_path in "${required_files[@]}"; do
  if [[ -s "$ROOT_DIR/$relative_path" ]]; then
    record_pass "required file: $relative_path"
  else
    record_fail "missing or empty required file: $relative_path"
  fi
done

uses_claude=0
if (( check_implementation == 1 )) && [[ "$implementer_agent" == "claude" ]]; then uses_claude=1; fi
if (( check_review == 1 )) && [[ "$reviewer_agent" == "claude" ]]; then uses_claude=1; fi
if (( uses_claude == 1 )); then
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
    "$ROOT_DIR/.claude/settings.json" >/dev/null 2>&1; then
    record_pass '.claude/settings.json is valid JSON'
  else
    record_fail '.claude/settings.json is missing or invalid JSON'
  fi

  if rg -n '"defaultMode"[[:space:]]*:[[:space:]]*"bypassPermissions"' \
    "$ROOT_DIR/.claude/settings.json" "$ROOT_DIR/.claude/settings.local.json" \
    >/dev/null 2>&1; then
    record_fail 'Claude settings contain forbidden bypassPermissions mode'
  else
    record_pass 'Claude settings do not bypass permissions'
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

  if node - "$ROOT_DIR/.claude/settings.json" <<'NODE'
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const denied = new Set(settings.permissions?.deny ?? []);
const required = [
  'Bash(git add *)', 'Bash(git commit *)', 'Bash(git push *)',
  'Bash(git reset *)', 'Bash(git clean *)', 'Bash(git checkout *)',
  'Bash(git switch *)', 'Bash(git rebase *)', 'Bash(git rm *)',
  'Task', 'Agent', 'Edit(./.git/**)'
];
if (required.some((rule) => !denied.has(rule))) process.exit(1);
NODE
  then
    record_pass 'Claude project policy contains required Git and sub-Agent denials'
  else
    record_fail 'Claude project policy is missing required denials'
  fi

  if claude --max-turns 1 --max-budget-usd 1.00 \
       --verbose --output-format stream-json --version >/dev/null 2>&1; then
    record_pass 'Claude CLI accepts autonomous guards and streaming telemetry flags'
  else
    record_fail 'Claude CLI does not accept required guard/streaming flags'
  fi
fi

if [[ -x "$ROOT_DIR/scripts/run-validation.sh" && \
      -x "$ROOT_DIR/scripts/agent-preflight.sh" && \
      -x "$ROOT_DIR/scripts/run-implementation.sh" && \
      -x "$ROOT_DIR/scripts/run-review.sh" && \
      -x "$ROOT_DIR/scripts/run-monitor.sh" && \
      -x "$ROOT_DIR/scripts/agent-cycle.sh" && \
      -x "$ROOT_DIR/scripts/agent-supervisor.sh" && \
      -x "$ROOT_DIR/scripts/agent-runners/claude.sh" && \
      -x "$ROOT_DIR/scripts/agent-runners/codex.sh" && \
      -x "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" && \
      -x "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" && \
      -x "$ROOT_DIR/scripts/generate-cycle-summary.sh" && \
      -x "$ROOT_DIR/scripts/test-agent-runtime.sh" && \
      -x "$ROOT_DIR/scripts/test-agent-supervisor.sh" ]]; then
  record_pass 'Agent entry and adapter scripts are executable'
else
  record_fail 'one or more Agent entry/adapter scripts are not executable'
fi

if bash -n \
  "$ROOT_DIR/scripts/agent-preflight.sh" \
  "$ROOT_DIR/scripts/lib/agent-runtime.sh" \
  "$ROOT_DIR/scripts/lib/implementation-round-state.sh" \
  "$ROOT_DIR/scripts/test-agent-runtime.sh" \
  "$ROOT_DIR/scripts/test-agent-supervisor.sh" \
  "$ROOT_DIR/scripts/run-implementation.sh" \
  "$ROOT_DIR/scripts/run-monitor.sh" \
  "$ROOT_DIR/scripts/run-review.sh" \
  "$ROOT_DIR/scripts/agent-runners/claude.sh" \
  "$ROOT_DIR/scripts/agent-runners/codex.sh" \
  "$ROOT_DIR/scripts/generate-cycle-summary.sh" \
  "$ROOT_DIR/scripts/agent-cycle.sh" \
  "$ROOT_DIR/scripts/agent-supervisor.sh"; then
  record_pass 'Agent shell scripts pass bash -n'
else
  record_fail 'Agent shell script syntax check failed'
fi

if node --check "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" >/dev/null && \
   node --check "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" >/dev/null; then
  record_pass 'Agent telemetry and usage-ledger parsers pass node --check'
else
  record_fail 'Agent telemetry or usage-ledger parser syntax check failed'
fi

if agent_runtime_prepare_npm_cache; then
  record_pass 'dedicated Agent npm cache is writable'
else
  record_fail 'dedicated Agent npm cache is not writable'
fi

runtime_values_ok=1
agent_runtime_config IMPLEMENTER_TIMEOUT_SECONDS 7200 60 43200 >/dev/null || runtime_values_ok=0
agent_runtime_config REVIEWER_TIMEOUT_SECONDS 3600 60 43200 >/dev/null || runtime_values_ok=0
agent_runtime_config MONITOR_TIMEOUT_SECONDS 900 60 7200 >/dev/null || runtime_values_ok=0
agent_runtime_enum_config MONITOR_MODE attached attached persistent-cli >/dev/null || runtime_values_ok=0
agent_runtime_config CLAUDE_IMPLEMENTER_MAX_TURNS 24 1 1000 >/dev/null || runtime_values_ok=0
agent_runtime_decimal_config CLAUDE_IMPLEMENTER_MAX_BUDGET_USD 4.00 >/dev/null || runtime_values_ok=0
agent_runtime_config CLAUDE_REVIEWER_MAX_TURNS 18 1 1000 >/dev/null || runtime_values_ok=0
agent_runtime_decimal_config CLAUDE_REVIEWER_MAX_BUDGET_USD 3.00 >/dev/null || runtime_values_ok=0
agent_runtime_config CLAUDE_MONITOR_MAX_TURNS 8 1 1000 >/dev/null || runtime_values_ok=0
agent_runtime_decimal_config CLAUDE_MONITOR_MAX_BUDGET_USD 1.00 >/dev/null || runtime_values_ok=0
agent_runtime_config CLAUDE_CONTEXT_ROTATE_TOKENS 160000 10000 1000000 >/dev/null || runtime_values_ok=0
agent_runtime_config AGENT_HEARTBEAT_SECONDS 30 5 300 >/dev/null || runtime_values_ok=0
agent_runtime_config AGENT_TERMINATION_GRACE_SECONDS 15 1 60 >/dev/null || runtime_values_ok=0
agent_runtime_config QUOTA_WAIT_SECONDS 18000 60 604800 >/dev/null || runtime_values_ok=0
agent_runtime_config MAX_QUOTA_RESUMES 6 1 100 >/dev/null || runtime_values_ok=0
agent_runtime_config SUPERVISOR_HEARTBEAT_SECONDS 300 30 3600 >/dev/null || runtime_values_ok=0
agent_runtime_config MAX_AUTONOMY_SLICES_PER_WINDOW 4 1 100 >/dev/null || runtime_values_ok=0
agent_runtime_config MONITOR_ACTION_TIMEOUT_SECONDS 7200 60 86400 >/dev/null || runtime_values_ok=0
if (( runtime_values_ok == 1 )); then
  record_pass '.agent/runtime.env timing values are within safe bounds'
else
  record_fail '.agent/runtime.env contains invalid timing values'
fi

current_round="$(sed -n 's/^CURRENT_ROUND=//p' "$STATE_FILE" | head -n 1)"
default_rounds="$(sed -n 's/^DEFAULT_ROUNDS=//p' "$STATE_FILE" | head -n 1)"
[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$default_rounds" =~ ^[1-9][0-9]*$ ]] || default_rounds=1
effective_max_rounds="${max_rounds_override:-$((current_round + default_rounds))}"
task_status="$(sed -n 's/^ACTIVE_TASK_STATUS=//p' "$STATE_FILE" | head -n 1)"
pending_review="$(sed -n 's/^PENDING_REVIEW=//p' "$STATE_FILE" | head -n 1)"
task_can_run=0
if (( control_only == 1 )); then
  task_can_run=1
elif [[ "$current_round" =~ ^[0-9]+$ && "$effective_max_rounds" =~ ^[1-9][0-9]*$ ]]; then
  if [[ "$pending_review" == "YES" && "$task_status" == "AWAITING_OWNER" && \
        "$check_review" == "1" ]]; then
    task_can_run=1
  elif [[ "$pending_review" != "YES" && \
          ( "$task_status" == "READY" || "$task_status" == "NEEDS_CHANGES" ) && \
          "$check_implementation" == "1" ]] && \
       (( current_round < effective_max_rounds )); then
    task_can_run=1
  fi
fi
if (( control_only == 1 )); then
  record_pass 'GENERAL control-event preflight is independent of implementation/review task phase'
elif (( task_can_run == 1 )); then
  record_pass "active task can run: status=$task_status, implementation=$current_round/$effective_max_rounds, pending_review=${pending_review:-NO}"
else
  record_fail "active task cannot run: status=$task_status, implementation=$current_round/$effective_max_rounds, pending_review=${pending_review:-NO}"
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
    record_fail '.git is not writable; wrapper cannot create checkpoints'
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
  checked_claude=0
  checked_codex=0
  if (( check_implementation == 1 )); then
    check_executor_external "$implementer_agent"
    [[ "$implementer_agent" == "claude" ]] && checked_claude=1 || checked_codex=1
  fi
  if (( check_review == 1 )); then
    if [[ "$reviewer_agent" == "claude" && "$checked_claude" == "0" ]] || \
       [[ "$reviewer_agent" == "codex" && "$checked_codex" == "0" ]]; then
      check_executor_external "$reviewer_agent"
    fi
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
