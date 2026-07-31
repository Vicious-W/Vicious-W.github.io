#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/supervisor-test"
FAKE_CYCLE="$TEST_DIR/fake-cycle.sh"
COUNT_FILE="$TEST_DIR/count"
ARGS_FILE="$TEST_DIR/second-args"
ATTEMPT_ARGS_DIR="$TEST_DIR/attempt-args"
TEST_HANDOFF_RELATIVE=".agent/artifacts/supervisor/test-implementer-successor-handoff.md"
TEST_HANDOFF="$ROOT_DIR/$TEST_HANDOFF_RELATIVE"
FAKE_SUMMARY="$TEST_DIR/fake-summary.sh"
FAKE_MONITOR="$TEST_DIR/fake-monitor.sh"
MONITOR_COUNT_FILE="$TEST_DIR/monitor-count"
FAKE_USAGE_FILE="$TEST_DIR/fake-usage.json"
ACTION_REQUEST_FILE="$ROOT_DIR/.agent/artifacts/supervisor/action-request.env"
ACTION_RESPONSE_FILE="$ROOT_DIR/.agent/artifacts/supervisor/action-response.env"
USAGE_LEDGER_FILE="$ROOT_DIR/.agent/artifacts/supervisor/usage-ledger.json"
USAGE_LEDGER_BACKUP="$TEST_DIR/usage-ledger.backup"
ATTACHED_LOG="$TEST_DIR/attached-handshake.log"
SUPERVISOR_TEST_PID=""
SUMMARY_CAPTURE="$TEST_DIR/summary-state.env"
TEST_REVIEW_BASE="$(git -C "$ROOT_DIR" rev-parse HEAD)"
STOP_FILE="$ROOT_DIR/.agent/artifacts/runtime/last-stop.env"
STOP_BACKUP="$TEST_DIR/last-stop.backup"
STATE_FILE="$ROOT_DIR/.agent/artifacts/supervisor/state.env"
STATE_BACKUP="$TEST_DIR/state.backup"
EVENT_FILE="$ROOT_DIR/.agent/artifacts/supervisor/events.log"
EVENT_BACKUP="$TEST_DIR/events.backup"

mkdir -p "$TEST_DIR" "$(dirname "$STOP_FILE")"
mkdir -p "$ATTEMPT_ARGS_DIR"
rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$FAKE_USAGE_FILE"
rm -f -- "$ATTEMPT_ARGS_DIR"/*.txt "$TEST_HANDOFF"
rm -f -- "$STOP_BACKUP" "$STATE_BACKUP" "$EVENT_BACKUP"
rm -f -- "$USAGE_LEDGER_BACKUP"
rm -f -- "$MONITOR_COUNT_FILE"
if [[ -f "$STOP_FILE" ]]; then
  cp "$STOP_FILE" "$STOP_BACKUP"
fi
if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$STATE_BACKUP"
fi
if [[ -f "$EVENT_FILE" ]]; then
  cp "$EVENT_FILE" "$EVENT_BACKUP"
fi
if [[ -f "$USAGE_LEDGER_FILE" ]]; then
  cp "$USAGE_LEDGER_FILE" "$USAGE_LEDGER_BACKUP"
fi

cleanup() {
  if [[ -n "$SUPERVISOR_TEST_PID" ]] && \
     kill -0 "$SUPERVISOR_TEST_PID" 2>/dev/null; then
    kill -TERM "$SUPERVISOR_TEST_PID" 2>/dev/null || true
    wait "$SUPERVISOR_TEST_PID" 2>/dev/null || true
  fi
  if [[ -f "$STOP_BACKUP" ]]; then
    cp "$STOP_BACKUP" "$STOP_FILE"
  else
    rm -f -- "$STOP_FILE"
  fi
  if [[ -f "$STATE_BACKUP" ]]; then
    cp "$STATE_BACKUP" "$STATE_FILE"
  else
    rm -f -- "$STATE_FILE"
  fi
  if [[ -f "$EVENT_BACKUP" ]]; then
    cp "$EVENT_BACKUP" "$EVENT_FILE"
  else
    rm -f -- "$EVENT_FILE"
  fi
  if [[ -f "$USAGE_LEDGER_BACKUP" ]]; then
    cp "$USAGE_LEDGER_BACKUP" "$USAGE_LEDGER_FILE"
  else
    rm -f -- "$USAGE_LEDGER_FILE"
  fi
  rm -f -- "$ACTION_REQUEST_FILE" "$ACTION_RESPONSE_FILE"
  rm -f -- "$TEST_HANDOFF" "$ATTEMPT_ARGS_DIR"/*.txt
}
trap cleanup EXIT

cat >"$FAKE_CYCLE" <<EOF
#!/usr/bin/env bash
set -uo pipefail
count=0
[[ -f "$COUNT_FILE" ]] && count="\$(sed -n '1p' "$COUNT_FILE")"
count=\$((count + 1))
printf '%s\n' "\$count" >"$COUNT_FILE"
printf '%s\n' "\$*" >"$ATTEMPT_ARGS_DIR/attempt-\$count.txt"
if (( count <= \${AGENT_FAKE_STOP_COUNT:-1} )); then
  if [[ -n "\${AGENT_FAKE_USAGE_RESET_EPOCH:-}" ]]; then
    printf '{"rateLimitResetsAt":%s}\n' \
      "\$AGENT_FAKE_USAGE_RESET_EPOCH" >"$FAKE_USAGE_FILE"
  fi
  {
    printf 'STOPPED_AT_UTC=2026-07-23T00:00:00Z\n'
    printf 'STAGE=%s\n' "\${AGENT_FAKE_STOP_STAGE:-REVIEWER}"
    printf 'STOP_REASON=%s\n' "\${AGENT_FAKE_STOP_REASON:-USAGE_OR_BILLING_LIMIT}"
    printf 'EXIT_CODE=1\n'
    printf 'LOG_FILE=.agent/artifacts/supervisor-test/fake.log\n'
    printf 'USAGE_FILE=%s\n' "$FAKE_USAGE_FILE"
    printf 'BASE_COMMIT=%s\n' "$TEST_REVIEW_BASE"
    printf 'IMPLEMENTER_SEGMENT=%s\n' "\${AGENT_FAKE_SEGMENT:-1}"
    printf 'SUCCESSOR_HANDOFF_FILE=%s\n' "\${AGENT_FAKE_HANDOFF_FILE:-}"
  } >"$STOP_FILE"
  exit 1
fi
printf '%s\n' "\$*" >"$ARGS_FILE"
exit 0
EOF
chmod +x "$FAKE_CYCLE"

cat >"$FAKE_SUMMARY" <<EOF
#!/usr/bin/env bash
cp "$STATE_FILE" "$SUMMARY_CAPTURE"
EOF
chmod +x "$FAKE_SUMMARY"

cat >"$FAKE_MONITOR" <<EOF
#!/usr/bin/env bash
set -uo pipefail
count=0
[[ -f "$MONITOR_COUNT_FILE" ]] && count="\$(sed -n '1p' "$MONITOR_COUNT_FILE")"
printf '%s\n' "\$((count + 1))" >"$MONITOR_COUNT_FILE"
printf 'MONITOR_ACTION: CONTINUE_NOW\n'
exit 0
EOF
chmod +x "$FAKE_MONITOR"

AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_FAKE_USAGE_RESET_EPOCH=2000000000 \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=0 \
AGENT_SUPERVISOR_ATTACHED_ACTION=CONTINUE_NOW \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --quota-anchor "2026-07-23 00:00:00 UTC" \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --implementer claude --implementer-model sonnet --implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium
supervisor_exit=$?

failure_count=0
if (( supervisor_exit == 0 )); then
  printf 'PASS  supervisor resumed after a simulated quota event\n'
else
  printf 'FAIL  supervisor exited %s during simulated quota recovery\n' "$supervisor_exit" >&2
  failure_count=$((failure_count + 1))
fi
if [[ "$(sed -n '1p' "$COUNT_FILE" 2>/dev/null)" == "2" ]]; then
  printf 'PASS  supervisor invoked the bounded cycle exactly twice\n'
else
  printf 'FAIL  supervisor did not perform exactly one resume\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fq -- '--start-stage reviewer' "$ARGS_FILE" 2>/dev/null; then
  printf 'PASS  reviewer quota stop resumed directly at REVIEWER\n'
else
  printf 'FAIL  supervisor did not preserve the interrupted REVIEWER stage\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fq -- "--review-base $TEST_REVIEW_BASE" "$ARGS_FILE" 2>/dev/null; then
  printf 'PASS  reviewer quota stop preserved its exact comparison base\n'
else
  printf 'FAIL  supervisor did not preserve the REVIEWER comparison base\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fq -- '--max-rounds 1' "$ARGS_FILE" 2>/dev/null; then
  printf 'PASS  supervisor preserved the run-specific round limit\n'
else
  printf 'FAIL  supervisor did not pass the run-specific round limit\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fqx 'SUPERVISOR_STATUS=COMPLETE' "$STATE_FILE" 2>/dev/null; then
  printf 'PASS  supervisor persisted the final COMPLETE state\n'
else
  printf 'FAIL  supervisor final state is not COMPLETE\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fqx 'SUPERVISOR_STATUS=COMPLETE' "$SUMMARY_CAPTURE" 2>/dev/null; then
  printf 'PASS  final summary sees the persisted COMPLETE supervisor state\n'
else
  printf 'FAIL  final summary ran before the COMPLETE state was persisted\n' >&2
  failure_count=$((failure_count + 1))
fi
if grep -Fq 'using executor-reported quota reset 2000000000' "$EVENT_FILE" && \
   grep -Fq 'until 2033-05-18T03:33:20Z' "$EVENT_FILE"; then
  printf 'PASS  executor-reported quota reset overrides the fixed anchor\n'
else
  printf 'FAIL  supervisor ignored the executor-reported quota reset\n' >&2
  failure_count=$((failure_count + 1))
fi

rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$FAKE_USAGE_FILE" "$TEST_HANDOFF"
rm -f -- "$ATTEMPT_ARGS_DIR"/*.txt
AGENT_FAKE_STOP_STAGE=IMPLEMENTER \
AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_SKIP_SESSION_SUPERSEDE=1 \
AGENT_SUPERVISOR_HANDOFF_FILE="$TEST_HANDOFF_RELATIVE" \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=0 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --implementer claude --implementer-model opus --implementer-effort high \
    --successor-implementer codex \
    --successor-implementer-model gpt-5.6-sol \
    --successor-implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium
successor_exit=$?
if (( successor_exit == 0 )) && \
   [[ "$(sed -n '1p' "$COUNT_FILE" 2>/dev/null)" == "2" ]] && \
   grep -Fq -- '--implementer codex' "$ATTEMPT_ARGS_DIR/attempt-2.txt" && \
   grep -Fq -- '--implementer-model gpt-5.6-sol' "$ATTEMPT_ARGS_DIR/attempt-2.txt" && \
   grep -Fq -- '--implementer-segment 2' "$ATTEMPT_ARGS_DIR/attempt-2.txt" && \
   grep -Fq -- "--implementer-handoff $TEST_HANDOFF_RELATIVE" \
     "$ATTEMPT_ARGS_DIR/attempt-2.txt" && \
   grep -Fq -- '--no-implementer-successor' "$ATTEMPT_ARGS_DIR/attempt-2.txt" && \
   grep -Fqx 'IMPLEMENTER_SWITCHES=1' "$STATE_FILE" && \
   grep -Fqx 'QUOTA_RESUMES=0' "$STATE_FILE" && \
   grep -Fqx 'ACTIVE_IMPLEMENTER=codex/gpt-5.6-sol/high' "$STATE_FILE" && \
   grep -Fq 'Predecessor runtime: `claude / opus / high`' "$TEST_HANDOFF" && \
   grep -Fq 'Successor runtime: `codex / gpt-5.6-sol / high`' "$TEST_HANDOFF"; then
  printf 'PASS  real IMPLEMENTER quota stop switches once to the serial Codex successor\n'
else
  printf 'FAIL  IMPLEMENTER successor handoff did not preserve runtime or round state\n' >&2
  failure_count=$((failure_count + 1))
fi

rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$FAKE_USAGE_FILE" "$TEST_HANDOFF"
rm -f -- "$ATTEMPT_ARGS_DIR"/*.txt
AGENT_FAKE_STOP_STAGE=IMPLEMENTER \
AGENT_FAKE_STOP_COUNT=2 \
AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_SKIP_SESSION_SUPERSEDE=1 \
AGENT_SUPERVISOR_HANDOFF_FILE="$TEST_HANDOFF_RELATIVE" \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=0 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --implementer claude --implementer-model opus --implementer-effort high \
    --successor-implementer codex \
    --successor-implementer-model gpt-5.6-sol \
    --successor-implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium
successor_quota_exit=$?
if (( successor_quota_exit == 0 )) && \
   [[ "$(sed -n '1p' "$COUNT_FILE" 2>/dev/null)" == "3" ]] && \
   grep -Fq -- '--implementer codex' "$ATTEMPT_ARGS_DIR/attempt-3.txt" && \
   grep -Fq -- '--no-implementer-successor' "$ATTEMPT_ARGS_DIR/attempt-3.txt" && \
   grep -Fqx 'IMPLEMENTER_SWITCHES=1' "$STATE_FILE" && \
   grep -Fqx 'QUOTA_RESUMES=1' "$STATE_FILE"; then
  printf 'PASS  successor quota stop waits/resumes Codex without bouncing back to Claude\n'
else
  printf 'FAIL  successor quota stop caused a second switch or lost recovery state\n' >&2
  failure_count=$((failure_count + 1))
fi

rm -f -- "$COUNT_FILE" "$ARGS_FILE"
AGENT_FAKE_STOP_REASON=AUTONOMY_SLICE_LIMIT \
AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=0 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --quota-anchor "2026-07-23 00:00:00 UTC" \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --monitor-mode attached \
    --implementer claude --implementer-model sonnet --implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium \
    >"$ATTACHED_LOG" 2>&1 &
SUPERVISOR_TEST_PID=$!
attached_event_id=""
for _ in $(seq 1 100); do
  if [[ -s "$ACTION_REQUEST_FILE" ]]; then
    attached_event_id="$(
      sed -n 's/^EVENT_ID=//p' "$ACTION_REQUEST_FILE" | head -n 1
    )"
    [[ -n "$attached_event_id" ]] && break
  fi
  sleep 0.05
done
if [[ -n "$attached_event_id" ]]; then
  "$ROOT_DIR/scripts/agent-cycle.sh" \
    supervisor-action CONTINUE_NOW "$attached_event_id" >/dev/null
fi
wait "$SUPERVISOR_TEST_PID"
slice_supervisor_exit=$?
SUPERVISOR_TEST_PID=""
if (( slice_supervisor_exit == 0 )) && \
   [[ -n "$attached_event_id" ]] && \
   [[ "$(sed -n '1p' "$COUNT_FILE" 2>/dev/null)" == "2" ]] && \
   grep -Fqx 'QUOTA_RESUMES=0' "$STATE_FILE" && \
   grep -Fqx 'AUTONOMY_SLICES=1' "$STATE_FILE"; then
  printf 'PASS  autonomy guard resumes immediately without pretending quota was exhausted\n'
else
  printf 'FAIL  autonomy guard was incorrectly routed through quota recovery\n' >&2
  sed -n '1,120p' "$ATTACHED_LOG" >&2
  failure_count=$((failure_count + 1))
fi

rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$MONITOR_COUNT_FILE"
AGENT_FAKE_STOP_REASON=AUTONOMY_SLICE_LIMIT \
AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_MONITOR_COMMAND="$FAKE_MONITOR" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=1 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --quota-anchor "2026-07-23 00:00:00 UTC" \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --monitor-mode persistent-cli \
    --implementer claude --implementer-model sonnet --implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium
persistent_supervisor_exit=$?
if (( persistent_supervisor_exit == 0 )) && \
   [[ "$(sed -n '1p' "$MONITOR_COUNT_FILE" 2>/dev/null)" == "2" ]] && \
   grep -Fqx 'LAST_MONITOR_ACTION=CONTINUE_NOW' "$STATE_FILE"; then
  printf 'PASS  persistent CLI GENERAL action controls the autonomy-guard resume\n'
else
  printf 'FAIL  persistent CLI GENERAL action was not executed by supervisor\n' >&2
  failure_count=$((failure_count + 1))
fi

rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$MONITOR_COUNT_FILE"
AGENT_FAKE_STOP_REASON=AUTONOMY_SLICE_LIMIT \
AGENT_FAKE_STOP_COUNT=4 \
AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_MONITOR_COMMAND="$FAKE_MONITOR" \
AGENT_SUPERVISOR_SUMMARY_COMMAND="$FAKE_SUMMARY" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=1 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --max-quota-resumes 2 \
    --max-rounds 1 \
    --monitor-mode persistent-cli \
    --implementer claude --implementer-model sonnet --implementer-effort high \
    --reviewer claude --reviewer-model sonnet --reviewer-effort max \
    --monitor codex --monitor-model gpt-5.6-terra --monitor-effort medium \
    >/dev/null 2>&1
slice_limit_exit=$?
if (( slice_limit_exit == 6 )) && \
   [[ "$(sed -n '1p' "$COUNT_FILE" 2>/dev/null)" == "4" ]] && \
   grep -Fqx 'AUTONOMY_SLICES=4' "$STATE_FILE" && \
   grep -Fqx 'LAST_STOP_REASON=MAX_AUTONOMY_SLICES' "$STATE_FILE" && \
   grep -Fqx 'PENDING_ACTION_ID=' "$STATE_FILE" && \
   [[ ! -e "$ACTION_REQUEST_FILE" && ! -e "$ACTION_RESPONSE_FILE" ]]; then
  printf 'PASS  per-window slice limit prevents persistent GENERAL from restarting forever\n'
else
  printf 'FAIL  per-window slice limit did not stop repeated automatic resumes\n' >&2
  failure_count=$((failure_count + 1))
fi

if "$ROOT_DIR/scripts/agent-cycle.sh" \
     supervisor-action WAIT_FOR_QUOTA stale-event >/dev/null 2>&1; then
  printf 'FAIL  attached GENERAL accepted an action with no pending event\n' >&2
  failure_count=$((failure_count + 1))
else
  printf 'PASS  attached GENERAL rejects stale or unsolicited actions\n'
fi

if (( failure_count != 0 )); then
  printf 'Supervisor smoke test failed: %s case(s).\n' "$failure_count" >&2
  exit 1
fi
printf 'Supervisor smoke test passed without launching a real Agent.\n'
