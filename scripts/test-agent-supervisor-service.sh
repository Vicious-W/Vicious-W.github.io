#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/.agent/artifacts/supervisor-service-test"
SERVICE_DIR="$TEST_DIR/service"
FAKE_SUPERVISOR="$TEST_DIR/fake-supervisor.sh"
SERVICE_SCRIPT="$ROOT_DIR/scripts/agent-supervisor-service.sh"
failure_count=0

mkdir -p "$TEST_DIR"

cat >"$FAKE_SUPERVISOR" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
[[ "${1:-}" == "supervise" ]] || exit 2
trap 'exit 143' TERM INT HUP
printf 'fake detached supervisor running\n'
while true; do
  sleep 1
done
EOF
chmod +x "$FAKE_SUPERVISOR"

service_command() {
  AGENT_SUPERVISOR_SERVICE_DIR="$SERVICE_DIR" \
  AGENT_SUPERVISOR_SERVICE_COMMAND="$FAKE_SUPERVISOR" \
    "$SERVICE_SCRIPT" "$@"
}

cycle_service_command() {
  AGENT_SUPERVISOR_SERVICE_DIR="$SERVICE_DIR" \
  AGENT_SUPERVISOR_SERVICE_COMMAND="$FAKE_SUPERVISOR" \
    "$ROOT_DIR/scripts/agent-cycle.sh" supervise "$@"
}

cleanup() {
  service_command stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf -- "$SERVICE_DIR"
active_status=""
if cycle_service_command --monitor-mode persistent-cli >/dev/null; then
  active_status="$(service_command status)"
fi
if [[ "$active_status" == *"SERVICE_STATUS=ACTIVE"* ]]; then
  printf 'PASS  persistent-cli dispatch detaches and remains active after launch\n'
else
  printf 'FAIL  detached supervisor did not survive its start command\n' >&2
  failure_count=$((failure_count + 1))
fi

if service_command start --monitor-mode persistent-cli >/dev/null 2>&1; then
  printf 'FAIL  detached supervisor allowed a duplicate active service\n' >&2
  failure_count=$((failure_count + 1))
else
  printf 'PASS  detached supervisor rejects duplicate starts\n'
fi

if service_command log 20 | grep -Fq 'fake detached supervisor running'; then
  printf 'PASS  detached supervisor exposes its persistent log\n'
else
  printf 'FAIL  detached supervisor log is unavailable\n' >&2
  failure_count=$((failure_count + 1))
fi

inactive_status=""
if service_command stop >/dev/null; then
  inactive_status="$(service_command status)"
fi
if [[ "$inactive_status" == *"SERVICE_STATUS=INACTIVE"* ]]; then
  printf 'PASS  detached supervisor stops its isolated process group\n'
else
  printf 'FAIL  detached supervisor did not stop cleanly\n' >&2
  failure_count=$((failure_count + 1))
fi

if (( failure_count != 0 )); then
  printf 'Detached supervisor service test failed: %s case(s).\n' \
    "$failure_count" >&2
  exit 1
fi
printf 'Detached supervisor service test passed without launching a real Agent.\n'
