#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/runtime-test"
LOCK_TEST_DIR="$TEST_DIR/test.lock"
MANIFEST_TEST="$TEST_DIR/test-manifest.env"
PROMPT_TEST="$TEST_DIR/test-prompt.md"
FAKE_BIN="$TEST_DIR/fake-bin"
FAKE_DATE_COUNTER="$TEST_DIR/fake-date-counter"
CLAUDE_EVENTS="$TEST_DIR/claude-events.json"
CLAUDE_QUOTA_EVENTS="$TEST_DIR/claude-quota.events.jsonl"
CODEX_EVENTS="$TEST_DIR/codex-events.jsonl"
USAGE_SUMMARY="$TEST_DIR/usage-summary.json"
CLAUDE_ARGS="$TEST_DIR/claude-args.txt"
SESSION_EVENTS="$TEST_DIR/session-events.json"
SESSION_TEST_TASK="runtime-session-test-$(date +%s%N)-$$"
QUOTA_SESSION_TEST_TASK="runtime-quota-session-test-$(date +%s%N)-$$"
MONITOR_SESSION_TEST_TASK="runtime-monitor-session-test-$(date +%s%N)-$$"
LEDGER_TEST="$TEST_DIR/usage-ledger.json"
LEDGER_RUN_DIR="$TEST_DIR/ledger-runs"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$ROOT_DIR/scripts/lib/agent-runtime.sh"
agent_runtime_init "$ROOT_DIR"
mkdir -p "$TEST_DIR"
mkdir -p "$FAKE_BIN"

cat >"$FAKE_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "+%s" ]]; then
  count=0
  [[ -f "$AGENT_FAKE_DATE_COUNTER" ]] &&
    count="$(sed -n '1p' "$AGENT_FAKE_DATE_COUNTER")"
  count=$((count + 10000))
  printf '%s\n' "$count" >"$AGENT_FAKE_DATE_COUNTER"
  printf '%s\n' "$count"
  exit 0
fi
exec /usr/bin/date "$@"
EOF
chmod +x "$FAKE_BIN/date"
rm -f -- "$FAKE_DATE_COUNTER"

failure_count=0

cleanup() {
  if [[ -d "$LOCK_TEST_DIR" ]]; then
    rm -f -- "$LOCK_TEST_DIR/pid" "$LOCK_TEST_DIR/start_ticks" \
      "$LOCK_TEST_DIR/command" "$LOCK_TEST_DIR/started_at_utc"
    rmdir "$LOCK_TEST_DIR" 2>/dev/null || true
  fi
  agent_stop_active_process
}
trap cleanup EXIT

expect_result() {
  local expected_exit="$1"
  local expected_reason="$2"
  local label="$3"
  shift 3

  "$@"
  local actual_exit=$?
  if [[ "$actual_exit" == "$expected_exit" && "$AGENT_RUN_REASON" == "$expected_reason" ]]; then
    printf 'PASS  %s (exit %s, reason %s)\n' "$label" "$actual_exit" "$AGENT_RUN_REASON"
  else
    printf 'FAIL  %s: expected exit %s/reason %s, got exit %s/reason %s\n' \
      "$label" "$expected_exit" "$expected_reason" "$actual_exit" "$AGENT_RUN_REASON" >&2
    failure_count=$((failure_count + 1))
  fi
}

expect_result 0 SUCCESS success \
  run_agent_process 'fake success child' 5 1 1 "$TEST_DIR/success.log" -- \
  bash -c 'sleep 3; printf "completed normally\n"'

PATH="$FAKE_BIN:$PATH" AGENT_FAKE_DATE_COUNTER="$FAKE_DATE_COUNTER" \
expect_result 0 SUCCESS suspend-safe-wall-clock \
  run_agent_process 'fake suspended-clock child' 5 1 1 \
  "$TEST_DIR/suspend-safe-wall-clock.log" -- \
  bash -c 'sleep 3; printf "completed across a wall-clock jump\n"'

expect_result 13 PERMISSION permission-failure \
  run_agent_process 'fake permission child' 5 1 1 "$TEST_DIR/permission.log" -- \
  bash -c 'printf "approval required: tool denied by policy\n" >&2; exit 13'

expect_result 42 USAGE_OR_BILLING_LIMIT usage-limit \
  run_agent_process 'fake usage-limit child' 5 1 1 "$TEST_DIR/usage-limit.log" -- \
  bash -c 'printf "You have hit your monthly spend limit\n" >&2; exit 42'

expect_result 43 AUTONOMY_SLICE_LIMIT autonomy-slice-limit \
  run_agent_process 'fake autonomy guard child' 5 1 1 "$TEST_DIR/slice-limit.log" -- \
  bash -c 'printf "Error: Reached max turns (36)\n" >&2; exit 43'

expect_result 124 TIMEOUT timeout \
  run_agent_process 'fake timeout child' 1 1 1 "$TEST_DIR/timeout.log" -- \
  bash -c 'sleep 5'

mkdir -p "$LOCK_TEST_DIR"
printf '999999999\n' >"$LOCK_TEST_DIR/pid"
printf '0\n' >"$LOCK_TEST_DIR/start_ticks"
printf 'fake stale owner\n' >"$LOCK_TEST_DIR/command"
if agent_acquire_lock "$LOCK_TEST_DIR" 'runtime smoke test' && \
   [[ "$(sed -n '1p' "$LOCK_TEST_DIR/pid")" == "$$" ]]; then
  printf 'PASS  stale lock was reclaimed with current owner metadata\n'
else
  printf 'FAIL  stale lock was not reclaimed safely\n' >&2
  failure_count=$((failure_count + 1))
fi

if agent_acquire_lock "$LOCK_TEST_DIR" 'unexpected duplicate owner'; then
  printf 'FAIL  active lock was acquired a second time\n' >&2
  failure_count=$((failure_count + 1))
else
  printf 'PASS  active lock blocked a second acquisition\n'
fi
agent_release_lock "$LOCK_TEST_DIR"

if agent_validate_executor claude && agent_validate_executor codex && \
   ! agent_validate_executor unknown >/dev/null 2>&1; then
  printf 'PASS  executor validation accepts supported adapters only\n'
else
  printf 'FAIL  executor validation did not enforce the supported set\n' >&2
  failure_count=$((failure_count + 1))
fi

if agent_validate_model gpt-5.6-sol && agent_validate_model opus-4.1 && \
   ! agent_validate_model 'bad model' >/dev/null 2>&1 && \
   agent_validate_effort high && ! agent_validate_effort extreme >/dev/null 2>&1; then
  printf 'PASS  model and effort values are validated as inert configuration\n'
else
  printf 'FAIL  model or effort validation produced an unexpected result\n' >&2
  failure_count=$((failure_count + 1))
fi

if [[ "$(agent_review_task_status PASS 1 3)" == "READY" && \
      "$(agent_review_task_status PASS 3 3)" == "COMPLETE" && \
      "$(agent_review_task_status CHANGES_REQUIRED 1 3)" == "NEEDS_CHANGES" ]]; then
  printf 'PASS  review verdict never reduces owner-requested implementation rounds\n'
else
  printf 'FAIL  review verdict produced an invalid next-round task state\n' >&2
  failure_count=$((failure_count + 1))
fi

agent_write_run_manifest \
  "$MANIFEST_TEST" test-run test-task 1 IMPLEMENTER claude sonnet high \
  workspace-write-no-git 600 base-sha PENDING .agent/implementation-report.md
if grep -Fqx 'ROLE=IMPLEMENTER' "$MANIFEST_TEST" && \
   grep -Fqx 'EXECUTOR=claude' "$MANIFEST_TEST" && \
   grep -Fqx 'PERMISSION_PROFILE=workspace-write-no-git' "$MANIFEST_TEST"; then
  printf 'PASS  run manifest records role, executor and permission profile\n'
else
  printf 'FAIL  run manifest is missing required identity fields\n' >&2
  failure_count=$((failure_count + 1))
fi

agent_prepare_role_session "$SESSION_TEST_TASK" IMPLEMENTER claude opus-4.8 high
first_session_id="$AGENT_SESSION_ID"
first_session_mode="$AGENT_SESSION_MODE"
printf '%s\n' \
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"$first_session_id\",\"result\":\"session created\"}" \
  >"$SESSION_EVENTS"
agent_finalize_role_session claude "$SESSION_EVENTS" SUCCESS
agent_prepare_role_session "$SESSION_TEST_TASK" IMPLEMENTER claude opus-4.8 high
if [[ "$first_session_mode" == "new" && "$AGENT_SESSION_MODE" == "resume" && \
      -n "$first_session_id" && "$AGENT_SESSION_ID" == "$first_session_id" ]]; then
  printf 'PASS  task-scoped role session changes from new to resume\n'
else
  printf 'FAIL  task-scoped role session was not reused deterministically\n' >&2
  failure_count=$((failure_count + 1))
fi
printf '%s\n' \
  '{"lastTurnCachedInputTokens":170000}' >"$USAGE_SUMMARY"
if agent_mark_role_session_rotation claude "$USAGE_SUMMARY" 160000; then
  agent_prepare_role_session "$SESSION_TEST_TASK" IMPLEMENTER claude opus-4.8 high
  if [[ "$AGENT_SESSION_MODE" == "new" && \
        "$AGENT_SESSION_GENERATION" == "2" && \
        "$AGENT_SESSION_ROTATED_FROM" == "$first_session_id" && \
        "$AGENT_SESSION_ID" != "$first_session_id" ]]; then
    printf 'PASS  context guard rotates one logical role session to a compacted generation\n'
  else
    printf 'FAIL  context guard did not create the expected session generation\n' >&2
    failure_count=$((failure_count + 1))
  fi
else
  printf 'FAIL  context guard did not mark an oversized Claude session\n' >&2
  failure_count=$((failure_count + 1))
fi
agent_prepare_role_session "$SESSION_TEST_TASK" REVIEWER claude opus-4.8 high
if [[ "$AGENT_SESSION_ID" != "$first_session_id" ]]; then
  printf 'PASS  IMPLEMENTER and REVIEWER receive isolated session IDs\n'
else
  printf 'FAIL  role isolation reused the IMPLEMENTER session for REVIEWER\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"11111111-1111-4111-a111-111111111111","num_turns":4,"duration_ms":1200,"total_cost_usd":0,"usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0},"modelUsage":{"router":{"inputTokens":100,"cacheReadInputTokens":80,"cacheCreationInputTokens":20,"outputTokens":30,"costUSD":1.25}},"result":"final report"}' \
  >"$CLAUDE_EVENTS"
if [[ "$(node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" final claude "$CLAUDE_EVENTS")" == \
      "final report" ]] && \
   [[ "$(node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" session claude "$CLAUDE_EVENTS")" == \
      "11111111-1111-4111-a111-111111111111" ]]; then
  printf 'PASS  Claude telemetry extracts final output and session ID\n'
else
  printf 'FAIL  Claude telemetry extraction failed\n' >&2
  failure_count=$((failure_count + 1))
fi
agent_record_telemetry claude "$CLAUDE_EVENTS" "$USAGE_SUMMARY" 3 2.00
if grep -Fq '"inputTokens": 100' "$USAGE_SUMMARY" && \
   grep -Fq '"totalCostUsd": 1.25' "$USAGE_SUMMARY" && \
   grep -Fq '"lastTurnCachedInputTokens":' "$USAGE_SUMMARY" && \
   grep -Fq '"reportedTurnsExceedNominalGuard": true' "$USAGE_SUMMARY" && \
   grep -Fq '"authority": "terminal-result-subtype"' "$USAGE_SUMMARY"; then
  printf 'PASS  Claude telemetry audits usage and nominal guard variance\n'
else
  printf 'FAIL  Claude telemetry lost usage or guard audit data\n' >&2
  failure_count=$((failure_count + 1))
fi

failed_task="runtime-failed-session-$$"
agent_prepare_role_session "$failed_task" IMPLEMENTER claude opus high
failed_preallocated_id="$AGENT_SESSION_ID"
: >"$TEST_DIR/failed-session.events.jsonl"
agent_finalize_role_session \
  claude "$TEST_DIR/failed-session.events.jsonl" AUTHENTICATION
failed_status="$(sed -n 's/^STATUS=//p' "$AGENT_SESSION_FILE" | head -n 1)"
agent_prepare_role_session "$failed_task" IMPLEMENTER claude opus high
if [[ "$failed_status" == "FAILED" && "$AGENT_SESSION_MODE" == "new" && \
      "$AGENT_SESSION_ID" != "$failed_preallocated_id" ]]; then
  printf 'PASS  startup failures never activate or resume a preallocated Claude session\n'
else
  printf 'FAIL  failed Claude startup left a resumable role session\n' >&2
  failure_count=$((failure_count + 1))
fi

agent_prepare_role_session \
  "$QUOTA_SESSION_TEST_TASK" IMPLEMENTER claude opus high
quota_session_id="$AGENT_SESSION_ID"
printf '%s\n' \
  "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$quota_session_id\"}" \
  "{\"type\":\"rate_limit_event\",\"session_id\":\"$quota_session_id\",\"rate_limit_info\":{\"status\":\"rejected\",\"resetsAt\":1784977200,\"rateLimitType\":\"five_hour\"}}" \
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"terminal_reason\":\"api_error\",\"api_error_status\":429,\"session_id\":\"$quota_session_id\",\"num_turns\":2,\"result\":\"You have hit your monthly spend limit\"}" \
  >"$CLAUDE_QUOTA_EVENTS"
agent_finalize_role_session \
  claude "$CLAUDE_QUOTA_EVENTS" USAGE_OR_BILLING_LIMIT
agent_prepare_role_session \
  "$QUOTA_SESSION_TEST_TASK" IMPLEMENTER claude opus high
if [[ "$AGENT_SESSION_MODE" == "resume" && \
      "$AGENT_SESSION_ID" == "$quota_session_id" ]]; then
  printf 'PASS  structured quota stops preserve the exact resumable role session\n'
else
  printf 'FAIL  structured quota stop discarded a resumable role session\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"44444444-4444-4444-a444-444444444444"}' \
  '{"type":"assistant","session_id":"44444444-4444-4444-a444-444444444444","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":1200,"cache_creation_input_tokens":30,"output_tokens":40}}}' \
  '{"type":"assistant","session_id":"44444444-4444-4444-a444-444444444444","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":1400,"cache_creation_input_tokens":31,"output_tokens":41}}}' \
  >"$TEST_DIR/live.events.jsonl"
live_usage="$(
  node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
    live claude "$TEST_DIR/live.events.jsonl"
)"
if [[ "$live_usage" == *'"turns":null'* && \
      "$live_usage" == *'"assistantEvents":2'* && \
      "$live_usage" == *'"cachedInputTokens":2600'* && \
      "$live_usage" == *'"lastTurnCachedInputTokens":1400'* ]]; then
  printf 'PASS  Claude stream telemetry separates live events from final turns\n'
else
  printf 'FAIL  Claude live telemetry did not aggregate streaming events\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"44444444-4444-4444-a444-444444444444","num_turns":0,"result":"replayed result"}' \
  '{"type":"system","subtype":"init","session_id":"44444444-4444-4444-a444-444444444444"}' \
  '{"type":"assistant","session_id":"44444444-4444-4444-a444-444444444444","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":900,"output_tokens":8}}}' \
  >"$TEST_DIR/replayed-result.events.jsonl"
replayed_usage="$(
  node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
    live claude "$TEST_DIR/replayed-result.events.jsonl"
)"
if node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
     outcome claude "$TEST_DIR/replayed-result.events.jsonl" >/dev/null 2>&1; then
  replayed_outcome_exit=0
else
  replayed_outcome_exit=$?
fi
if [[ "$replayed_usage" == *'"final":false'* && \
      "$replayed_usage" == *'"turns":null'* && \
      "$replayed_usage" == *'"assistantEvents":1'* && \
      "$replayed_outcome_exit" == "4" ]]; then
  printf 'PASS  resumed Claude streams ignore a replayed historical result\n'
else
  printf 'FAIL  replayed Claude result was mistaken for the current terminal result\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"44444444-4444-4444-a444-444444444444","num_turns":5,"result":"current result"}' \
  >>"$TEST_DIR/replayed-result.events.jsonl"
completed_replay_usage="$(
  node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
    live claude "$TEST_DIR/replayed-result.events.jsonl"
)"
if [[ "$completed_replay_usage" == *'"final":true'* && \
      "$completed_replay_usage" == *'"turns":5'* && \
      "$completed_replay_usage" == *'"assistantEvents":1'* ]]; then
  printf 'PASS  resumed Claude stream accepts only its last result as terminal\n'
else
  printf 'FAIL  current Claude terminal result was not isolated from replay history\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"44444444-4444-4444-a444-444444444444","num_turns":3,"total_cost_usd":2.5}' \
  >"$TEST_DIR/guard.events.jsonl"
if node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
     outcome claude "$TEST_DIR/guard.events.jsonl" >/dev/null 2>&1; then
  guard_outcome_exit=0
else
  guard_outcome_exit=$?
fi
if (( guard_outcome_exit == 75 )); then
  printf 'PASS  structured Claude guard results receive a dedicated nonzero exit\n'
else
  printf 'FAIL  structured Claude guard result exit was %s, expected 75\n' \
    "$guard_outcome_exit" >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"66666666-6666-4666-a666-666666666666"}' \
  '{"type":"rate_limit_event","session_id":"66666666-6666-4666-a666-666666666666","rate_limit_info":{"status":"rejected","resetsAt":1784977200,"rateLimitType":"five_hour","isUsingOverage":false}}' \
  '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"session_id":"66666666-6666-4666-a666-666666666666","num_turns":11,"result":"You have hit your monthly spend limit"}' \
  >"$CLAUDE_QUOTA_EVENTS"
if node "$ROOT_DIR/scripts/lib/agent-telemetry.mjs" \
     outcome claude "$CLAUDE_QUOTA_EVENTS" >"$TEST_DIR/quota-outcome.log" 2>&1; then
  quota_outcome_exit=0
else
  quota_outcome_exit=$?
fi
agent_record_telemetry claude "$CLAUDE_QUOTA_EVENTS" "$USAGE_SUMMARY" 24 4.00
if (( quota_outcome_exit == 76 )) && \
   grep -Fq 'reason=USAGE_OR_BILLING_LIMIT' "$TEST_DIR/quota-outcome.log" && \
   grep -Fq '"quotaLimited": true' "$USAGE_SUMMARY" && \
   grep -Fq '"rateLimitType": "five_hour"' "$USAGE_SUMMARY" && \
   grep -Fq '"rateLimitResetsAt": 1784977200' "$USAGE_SUMMARY" && \
   [[ "$(agent_classify_log "$TEST_DIR/quota-outcome.log")" == \
      "USAGE_OR_BILLING_LIMIT" ]]; then
  printf 'PASS  contradictory Claude success/429 results classify as recoverable quota\n'
else
  printf 'FAIL  structured Claude 429 result was not preserved as a quota event\n' >&2
  failure_count=$((failure_count + 1))
fi

mkdir -p "$LEDGER_RUN_DIR"
printf '%s\n' \
  '{"executor":"claude","turns":3,"totalCostUsd":2.5,"inputTokens":10,"cachedInputTokens":2000,"cacheCreationInputTokens":20,"outputTokens":50}' \
  >"$TEST_DIR/ledger-usage.json"
{
  printf 'RUN_ID=ledger-test\n'
  printf 'TASK_ID=ledger-task\n'
  printf 'ROLE=IMPLEMENTER\n'
  printf 'ROUND=1\n'
  printf 'MODEL=opus\n'
  printf 'EFFORT=high\n'
  printf 'STARTED_AT_UTC=2026-07-24T00:00:01Z\n'
  printf 'FINISHED_AT_UTC=2026-07-24T00:01:00Z\n'
  printf 'STATUS=AUTONOMY_SLICE_LIMIT\n'
  printf 'USAGE_FILE=%s\n' "${TEST_DIR#"$ROOT_DIR/"}/ledger-usage.json"
} >"$LEDGER_RUN_DIR/ledger-test.env"
node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" init \
  "$LEDGER_TEST" ledger-task 2026-07-24T00:00:00Z
node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" sync \
  "$LEDGER_TEST" "$LEDGER_RUN_DIR" "$ROOT_DIR" 2026-07-24T00:02:00Z
ledger_totals="$(
  node "$ROOT_DIR/scripts/lib/agent-usage-ledger.mjs" summary "$LEDGER_TEST"
)"
if [[ "$ledger_totals" == *'"runs":1'* && \
      "$ledger_totals" == *'"turns":3'* && \
      "$ledger_totals" == *'"totalCostUsd":2.5'* ]]; then
  printf 'PASS  supervisor usage ledger accumulates run manifests without double counting\n'
else
  printf 'FAIL  supervisor usage ledger totals are incomplete\n' >&2
  failure_count=$((failure_count + 1))
fi

cat >"$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$AGENT_FAKE_CLAUDE_ARGS"
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"33333333-3333-4333-a333-333333333333"}' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"33333333-3333-4333-a333-333333333333","num_turns":1,"duration_ms":1,"usage":{"iterations":[{"cache_read_input_tokens":10}]},"result":"fake final"}'
EOF
chmod +x "$FAKE_BIN/claude"
AGENT_FAKE_CLAUDE_ARGS="$CLAUDE_ARGS" \
AGENT_SESSION_ID="33333333-3333-4333-a333-333333333333" \
AGENT_SESSION_MODE=new \
AGENT_EVENT_FILE="$TEST_DIR/fake-runner-events.jsonl" \
AGENT_CLAUDE_MAX_TURNS=36 \
AGENT_CLAUDE_MAX_BUDGET_USD=6.00 \
PATH="$FAKE_BIN:$PATH" \
  "$ROOT_DIR/scripts/agent-runners/claude.sh" \
    IMPLEMENTER opus high "$PROMPT_TEST" - >/dev/null
if grep -Fq -- '--max-turns 36' "$CLAUDE_ARGS" && \
   grep -Fq -- '--max-budget-usd 6.00' "$CLAUDE_ARGS" && \
   grep -Fq -- '--output-format stream-json' "$CLAUDE_ARGS"; then
  printf 'PASS  Claude adapter forwards guards and enables streaming telemetry\n'
else
  printf 'FAIL  Claude adapter omitted one or more autonomous guards\n' >&2
  failure_count=$((failure_count + 1))
fi

cat >"$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"55555555-5555-4555-a555-555555555555"}' \
  '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"session_id":"55555555-5555-4555-a555-555555555555","num_turns":2,"total_cost_usd":6}'
exit 0
EOF
chmod +x "$FAKE_BIN/claude"
if AGENT_SESSION_ID="55555555-5555-4555-a555-555555555555" \
   AGENT_SESSION_MODE=new \
   AGENT_EVENT_FILE="$TEST_DIR/fake-guard-events.jsonl" \
   AGENT_CLAUDE_MAX_TURNS=36 \
   AGENT_CLAUDE_MAX_BUDGET_USD=6.00 \
   PATH="$FAKE_BIN:$PATH" \
     "$ROOT_DIR/scripts/agent-runners/claude.sh" \
       IMPLEMENTER opus high "$PROMPT_TEST" - >/dev/null 2>&1; then
  fake_guard_exit=0
else
  fake_guard_exit=$?
fi
if (( fake_guard_exit == 75 )); then
  printf 'PASS  Claude adapter rejects a structured guard result even when CLI exits zero\n'
else
  printf 'FAIL  Claude adapter returned %s for a structured budget guard\n' \
    "$fake_guard_exit" >&2
  failure_count=$((failure_count + 1))
fi

cat >"$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"77777777-7777-4777-a777-777777777777"}' \
  '{"type":"rate_limit_event","session_id":"77777777-7777-4777-a777-777777777777","rate_limit_info":{"status":"rejected","resetsAt":1784977200,"rateLimitType":"five_hour"}}' \
  '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"session_id":"77777777-7777-4777-a777-777777777777","num_turns":2,"result":"You have hit your monthly spend limit"}'
exit 0
EOF
chmod +x "$FAKE_BIN/claude"
if AGENT_SESSION_ID="77777777-7777-4777-a777-777777777777" \
   AGENT_SESSION_MODE=new \
   AGENT_EVENT_FILE="$TEST_DIR/fake-quota-events.jsonl" \
   AGENT_CLAUDE_MAX_TURNS=36 \
   AGENT_CLAUDE_MAX_BUDGET_USD=6.00 \
   PATH="$FAKE_BIN:$PATH" \
     "$ROOT_DIR/scripts/agent-runners/claude.sh" \
       IMPLEMENTER opus high "$PROMPT_TEST" - \
       >"$TEST_DIR/fake-quota-runner.log" 2>&1; then
  fake_quota_exit=0
else
  fake_quota_exit=$?
fi
if (( fake_quota_exit == 76 )) && \
   [[ "$(agent_classify_log "$TEST_DIR/fake-quota-runner.log")" == \
      "USAGE_OR_BILLING_LIMIT" ]]; then
  printf 'PASS  Claude adapter preserves structured quota status despite subtype success\n'
else
  printf 'FAIL  Claude adapter returned %s for a structured quota event\n' \
    "$fake_quota_exit" >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  '{"type":"thread.started","thread_id":"22222222-2222-4222-a222-222222222222"}' \
  '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":150,"output_tokens":40}}' \
  >"$CODEX_EVENTS"
agent_record_telemetry codex "$CODEX_EVENTS" "$USAGE_SUMMARY"
if grep -Fq '"inputTokens": 200' "$USAGE_SUMMARY" && \
   grep -Fq '"cachedInputTokens": 150' "$USAGE_SUMMARY"; then
  printf 'PASS  Codex telemetry records available token and cache data\n'
else
  printf 'FAIL  Codex telemetry summary is missing usage data\n' >&2
  failure_count=$((failure_count + 1))
fi
agent_prepare_role_session \
  "$MONITOR_SESSION_TEST_TASK" MONITOR codex gpt-5.6-terra medium
agent_finalize_role_session codex "$CODEX_EVENTS" SUCCESS
monitor_session_id="$AGENT_SESSION_ID"
agent_prepare_role_session \
  "$MONITOR_SESSION_TEST_TASK" MONITOR codex gpt-5.6-terra medium
if [[ "$AGENT_SESSION_MODE" == "resume" && \
      "$AGENT_SESSION_ID" == "$monitor_session_id" && \
      -n "$monitor_session_id" ]]; then
  printf 'PASS  task-scoped CLI MONITOR resumes one persistent conversation\n'
else
  printf 'FAIL  CLI MONITOR session was not persisted across events\n' >&2
  failure_count=$((failure_count + 1))
fi

printf '%s\n' \
  'There is an issue with the selected model. It may not exist or you may not have access.' \
  >"$TEST_DIR/model-unavailable.log"
if [[ "$(agent_classify_log "$TEST_DIR/model-unavailable.log")" == "MODEL_UNAVAILABLE" ]]; then
  printf 'PASS  unavailable models are classified without invoking MONITOR\n'
else
  printf 'FAIL  unavailable model error was not classified\n' >&2
  failure_count=$((failure_count + 1))
fi

printf 'test prompt\n' >"$PROMPT_TEST"
for adapter in claude codex; do
  if "$ROOT_DIR/scripts/agent-runners/$adapter.sh" \
    INVALID test-model high "$PROMPT_TEST" - >/dev/null 2>&1; then
    printf 'FAIL  %s adapter accepted an invalid role\n' "$adapter" >&2
    failure_count=$((failure_count + 1))
  else
    printf 'PASS  %s adapter rejects invalid roles without starting an Agent\n' "$adapter"
  fi
done

if (( failure_count != 0 )); then
  printf 'Runtime supervision smoke test failed: %s case(s).\n' "$failure_count" >&2
  exit 1
fi

printf 'Runtime supervision smoke test passed without launching a real Agent.\n'
