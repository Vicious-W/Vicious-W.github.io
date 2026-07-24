#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/runtime-test"
LOCK_TEST_DIR="$TEST_DIR/test.lock"
MANIFEST_TEST="$TEST_DIR/test-manifest.env"
PROMPT_TEST="$TEST_DIR/test-prompt.md"
FAKE_BIN="$TEST_DIR/fake-bin"
FAKE_DATE_COUNTER="$TEST_DIR/fake-date-counter"

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
