#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/runtime-test"
LOCK_TEST_DIR="$TEST_DIR/test.lock"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$ROOT_DIR/scripts/lib/agent-runtime.sh"
agent_runtime_init "$ROOT_DIR"
mkdir -p "$TEST_DIR"

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

expect_result 13 PERMISSION permission-failure \
  run_agent_process 'fake permission child' 5 1 1 "$TEST_DIR/permission.log" -- \
  bash -c 'printf "approval required: tool denied by policy\n" >&2; exit 13'

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

if (( failure_count != 0 )); then
  printf 'Runtime supervision smoke test failed: %s case(s).\n' "$failure_count" >&2
  exit 1
fi

printf 'Runtime supervision smoke test passed without launching a real Agent.\n'
