#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/runtime-test"

# shellcheck source=scripts/lib/agent-runtime.sh
source "$ROOT_DIR/scripts/lib/agent-runtime.sh"
agent_runtime_init "$ROOT_DIR"
mkdir -p "$TEST_DIR"

failure_count=0

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

if (( failure_count != 0 )); then
  printf 'Runtime supervision smoke test failed: %s case(s).\n' "$failure_count" >&2
  exit 1
fi

printf 'Runtime supervision smoke test passed without launching a real Agent.\n'
