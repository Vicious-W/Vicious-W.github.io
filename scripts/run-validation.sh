#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.agent/artifacts/validation"
SUMMARY_FILE="$ARTIFACT_DIR/summary.md"
ROWS_FILE="$ARTIFACT_DIR/.rows.tmp"

mkdir -p "$ARTIFACT_DIR"
: >"$ROWS_FILE"

overall_status=0
started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf 'UNAVAILABLE')"

if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all 2>/dev/null)" ]]; then
  worktree="dirty"
else
  worktree="clean"
fi

record_result() {
  local label="$1"
  local status="$2"
  local log_path="$3"
  printf '| %s | %s | `%s` |\n' "$label" "$status" "$log_path" >>"$ROWS_FILE"
}

has_script() {
  local script_name="$1"
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, process.argv[2]) ? 0 : 1);
  ' "$ROOT_DIR/package.json" "$script_name"
}

run_package_script() {
  local script_name="$1"
  case "$package_manager" in
    npm) CI=1 npm --prefix "$ROOT_DIR" run "$script_name" ;;
    pnpm) (cd "$ROOT_DIR" && CI=1 pnpm run "$script_name") ;;
    yarn) (cd "$ROOT_DIR" && CI=1 yarn run "$script_name") ;;
    bun) (cd "$ROOT_DIR" && CI=1 bun run "$script_name") ;;
    *) return 127 ;;
  esac
}

run_configured_check() {
  local label="$1"
  local script_name="$2"
  local log_name="$3"
  local required="$4"
  local log_file="$ARTIFACT_DIR/$log_name"

  if ! has_script "$script_name"; then
    printf '%s script is not configured in package.json.\n' "$script_name" >"$log_file"
    record_result "$label" "NOT CONFIGURED" ".agent/artifacts/validation/$log_name"
    if [[ "$required" == "required" ]]; then
      overall_status=1
    fi
    return
  fi

  if run_package_script "$script_name" >"$log_file" 2>&1; then
    record_result "$label" "PASS" ".agent/artifacts/validation/$log_name"
  else
    local exit_code=$?
    printf '\nCommand exit code: %s\n' "$exit_code" >>"$log_file"
    record_result "$label" "FAIL" ".agent/artifacts/validation/$log_name"
    overall_status=1
  fi
}

package_manager=""
lockfile_count=0

for lockfile in package-lock.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do
  if [[ -f "$ROOT_DIR/$lockfile" ]]; then
    lockfile_count=$((lockfile_count + 1))
    case "$lockfile" in
      package-lock.json) detected_manager="npm" ;;
      pnpm-lock.yaml) detected_manager="pnpm" ;;
      yarn.lock) detected_manager="yarn" ;;
      bun.lock|bun.lockb) detected_manager="bun" ;;
    esac
    package_manager="$detected_manager"
  fi
done

if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  printf 'package.json is missing.\n' >"$ARTIFACT_DIR/dependencies.log"
  record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
  package_manager="UNAVAILABLE"
  overall_status=1
elif (( lockfile_count == 0 )); then
  printf 'No supported lockfile was found.\n' >"$ARTIFACT_DIR/dependencies.log"
  record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
  package_manager="UNDETERMINED"
  overall_status=1
elif (( lockfile_count > 1 )); then
  printf 'Multiple package-manager lockfiles were found; refusing to guess.\n' >"$ARTIFACT_DIR/dependencies.log"
  record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
  package_manager="AMBIGUOUS"
  overall_status=1
elif ! command -v "$package_manager" >/dev/null 2>&1; then
  printf 'Required package manager %s is not available on PATH.\n' "$package_manager" >"$ARTIFACT_DIR/dependencies.log"
  record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
  overall_status=1
elif [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  printf 'node_modules is missing. Run the documented dependency installation command first.\n' >"$ARTIFACT_DIR/dependencies.log"
  record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
  overall_status=1
elif [[ "$package_manager" == "npm" ]]; then
  if npm --prefix "$ROOT_DIR" ls --depth=0 >"$ARTIFACT_DIR/dependencies.log" 2>&1; then
    record_result "Dependency check" "PASS" ".agent/artifacts/validation/dependencies.log"
  else
    dependency_exit=$?
    printf '\nCommand exit code: %s\n' "$dependency_exit" >>"$ARTIFACT_DIR/dependencies.log"
    record_result "Dependency check" "FAIL" ".agent/artifacts/validation/dependencies.log"
    overall_status=1
  fi
else
  {
    printf 'Package manager: %s\n' "$package_manager"
    "$package_manager" --version
    printf 'node_modules is present; project-specific dependency integrity is not configured.\n'
  } >"$ARTIFACT_DIR/dependencies.log" 2>&1
  record_result "Dependency check" "PASS (limited)" ".agent/artifacts/validation/dependencies.log"
fi

if [[ -f "$ROOT_DIR/package.json" ]] && command -v node >/dev/null 2>&1 && [[ "$package_manager" != "UNAVAILABLE" && "$package_manager" != "UNDETERMINED" && "$package_manager" != "AMBIGUOUS" ]]; then
  run_configured_check "Build" "build" "build.log" "required"
  run_configured_check "Tests" "test" "tests.log" "optional"
  run_configured_check "Lint" "lint" "lint.log" "optional"

  if has_script "typecheck"; then
    run_configured_check "Type check" "typecheck" "typecheck.log" "optional"
  elif has_script "type-check"; then
    run_configured_check "Type check" "type-check" "typecheck.log" "optional"
  else
    printf 'Neither typecheck nor type-check is configured in package.json.\n' >"$ARTIFACT_DIR/typecheck.log"
    record_result "Type check" "NOT CONFIGURED" ".agent/artifacts/validation/typecheck.log"
  fi
else
  for entry in "Build:build.log" "Tests:tests.log" "Lint:lint.log" "Type check:typecheck.log"; do
    label="${entry%%:*}"
    log_name="${entry#*:}"
    printf 'Skipped because the package environment is unavailable.\n' >"$ARTIFACT_DIR/$log_name"
    record_result "$label" "NOT RUN" ".agent/artifacts/validation/$log_name"
  done
  overall_status=1
fi

if (( overall_status == 0 )); then
  final_status="PASS"
else
  final_status="FAIL"
fi

{
  printf '# Validation summary\n\n'
  printf -- '- Started: %s\n' "$started_at"
  printf -- '- Commit: `%s`\n' "$commit"
  printf -- '- Working tree: %s\n' "$worktree"
  printf -- '- Package manager: %s\n' "$package_manager"
  printf -- '- Overall configured-check status: **%s**\n\n' "$final_status"
  printf '| Check | Status | Log |\n'
  printf '| --- | --- | --- |\n'
  cat "$ROWS_FILE"
  printf '| Browser / visual | MANUAL REQUIRED | Playwright MCP; not a Bash test |\n\n'
  printf '## Browser verification still required\n\n'
  printf 'For any page appearance or behavior change, an implementing or reviewing Agent must use Playwright MCP at 390×844, 768×1024, and 1440×900, exercise the affected flow, and inspect the browser console. This script does not claim that work passed.\n'
} >"$SUMMARY_FILE"

rm -f -- "$ROWS_FILE"

printf 'Validation summary: %s\n' "$SUMMARY_FILE"
printf 'Configured-check status: %s\n' "$final_status"
exit "$overall_status"
