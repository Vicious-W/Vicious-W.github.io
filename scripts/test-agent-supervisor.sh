#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/supervisor-test"
FAKE_CYCLE="$TEST_DIR/fake-cycle.sh"
COUNT_FILE="$TEST_DIR/count"
ARGS_FILE="$TEST_DIR/second-args"
STOP_FILE="$ROOT_DIR/.agent/artifacts/runtime/last-stop.env"
STOP_BACKUP="$TEST_DIR/last-stop.backup"
STATE_FILE="$ROOT_DIR/.agent/artifacts/supervisor/state.env"
STATE_BACKUP="$TEST_DIR/state.backup"
EVENT_FILE="$ROOT_DIR/.agent/artifacts/supervisor/events.log"
EVENT_BACKUP="$TEST_DIR/events.backup"

mkdir -p "$TEST_DIR" "$(dirname "$STOP_FILE")"
rm -f -- "$COUNT_FILE" "$ARGS_FILE" "$STOP_BACKUP" "$STATE_BACKUP" "$EVENT_BACKUP"
if [[ -f "$STOP_FILE" ]]; then
  cp "$STOP_FILE" "$STOP_BACKUP"
fi
if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$STATE_BACKUP"
fi
if [[ -f "$EVENT_FILE" ]]; then
  cp "$EVENT_FILE" "$EVENT_BACKUP"
fi

cleanup() {
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
}
trap cleanup EXIT

cat >"$FAKE_CYCLE" <<EOF
#!/usr/bin/env bash
set -uo pipefail
count=0
[[ -f "$COUNT_FILE" ]] && count="\$(sed -n '1p' "$COUNT_FILE")"
count=\$((count + 1))
printf '%s\n' "\$count" >"$COUNT_FILE"
if (( count == 1 )); then
  {
    printf 'STOPPED_AT_UTC=2026-07-23T00:00:00Z\n'
    printf 'STAGE=REVIEWER\n'
    printf 'STOP_REASON=USAGE_OR_BILLING_LIMIT\n'
    printf 'EXIT_CODE=1\n'
    printf 'LOG_FILE=.agent/artifacts/supervisor-test/fake.log\n'
  } >"$STOP_FILE"
  exit 1
fi
printf '%s\n' "\$*" >"$ARGS_FILE"
exit 0
EOF
chmod +x "$FAKE_CYCLE"

AGENT_SUPERVISOR_CYCLE_COMMAND="$FAKE_CYCLE" \
AGENT_SUPERVISOR_NO_SLEEP=1 \
AGENT_SUPERVISOR_SKIP_RECOVERY=1 \
AGENT_SUPERVISOR_ALLOW_DIRTY_TEST=1 \
AGENT_SUPERVISOR_MONITOR_ON_ERROR=0 \
  "$ROOT_DIR/scripts/agent-supervisor.sh" supervise \
    --quota-wait-seconds 60 \
    --quota-anchor "2026-07-23 00:00:00 UTC" \
    --max-quota-resumes 2 \
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
if grep -Fqx 'SUPERVISOR_STATUS=COMPLETE' "$STATE_FILE" 2>/dev/null; then
  printf 'PASS  supervisor persisted the final COMPLETE state\n'
else
  printf 'FAIL  supervisor final state is not COMPLETE\n' >&2
  failure_count=$((failure_count + 1))
fi

if (( failure_count != 0 )); then
  printf 'Supervisor smoke test failed: %s case(s).\n' "$failure_count" >&2
  exit 1
fi
printf 'Supervisor smoke test passed without launching a real Agent.\n'
