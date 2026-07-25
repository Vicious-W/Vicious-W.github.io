#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/.agent"
STATE_FILE="$AGENT_DIR/state.env"
RUNTIME_FILE="$AGENT_DIR/runtime.env"
STOP_FILE="$AGENT_DIR/artifacts/runtime/last-stop.env"
SUPERVISOR_STATE_FILE="$AGENT_DIR/artifacts/supervisor/state.env"
SUPERVISOR_USAGE_LEDGER="$AGENT_DIR/artifacts/supervisor/usage-ledger.json"
CYCLE_RUNTIME_FILE="$AGENT_DIR/artifacts/cycle/runtime.env"
RUN_DIR="$AGENT_DIR/artifacts/runs"
OUTPUT_DIR="$AGENT_DIR/artifacts/cycle"
OUTPUT_FILE="$OUTPUT_DIR/latest-summary.md"
HISTORY_DIR="$OUTPUT_DIR/history"
CYCLE_EXIT="${1:-}"

value_from() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -n 1
}

state_value() { value_from "$STATE_FILE" "$1"; }
runtime_value() { value_from "$RUNTIME_FILE" "$1"; }
stop_value() { value_from "$STOP_FILE" "$1"; }
supervisor_value() { value_from "$SUPERVISOR_STATE_FILE" "$1"; }
cycle_runtime_value() { value_from "$CYCLE_RUNTIME_FILE" "$1"; }
manifest_value() {
  local file="$1"
  local key="$2"
  value_from "$file" "$key"
}

report_change_titles() {
  awk '
    $0 == "## Changes made" { active = 1; next }
    active && /^## / { exit }
    active && /^### / {
      line = $0
      sub(/^### /, "", line)
      sub(/^[^:]+: /, "", line)
      print line
    }
  ' "$1"
}

report_findings() {
  awk '
    /^## (Blocker|Major|Minor|Suggestions)$/ { section = $2; next }
    /^## / { section = "" }
    section != "" && /^### / {
      line = $0
      sub(/^### /, "", line)
      printf "%s\t%s\n", section, line
    }
  ' "$1"
}

join_changed_files() {
  git -C "$ROOT_DIR" diff-tree --no-commit-id --name-only -r "$1" |
    awk 'BEGIN { first = 1 } {
      if (!first) printf ", "
      printf "%s", $0
      first = 0
    } END { print "" }'
}

mkdir -p "$OUTPUT_DIR" "$HISTORY_DIR"
summary_tmp="$(mktemp /tmp/agent-cycle-summary.XXXXXX)"
report_tmp="$(mktemp /tmp/agent-cycle-report.XXXXXX)"
cleanup() { rm -f -- "$summary_tmp" "$report_tmp"; }
trap cleanup EXIT

task_id="$(state_value ACTIVE_TASK_ID)"
task_slug="$(printf '%s' "${task_id:-unknown}" | tr -c '[:alnum:]_.-' '_')"
task_status="$(state_value ACTIVE_TASK_STATUS)"
current_round="$(state_value CURRENT_ROUND)"
max_rounds="$(state_value MAX_ROUNDS)"
last_verdict="$(state_value LAST_REVIEW_VERDICT)"
[[ "$current_round" =~ ^[0-9]+$ ]] || current_round=0
[[ "$max_rounds" =~ ^[1-9][0-9]*$ ]] || max_rounds=3
if [[ "$(cycle_runtime_value TASK_ID)" == "$task_id" && \
      "$(cycle_runtime_value EFFECTIVE_MAX_ROUNDS)" =~ ^[1-9][0-9]*$ ]]; then
  max_rounds="$(cycle_runtime_value EFFECTIVE_MAX_ROUNDS)"
fi

first_implementation_manifest=""
latest_implementation_manifest=""
declare -A implementation_manifests=()
declare -A review_manifests=()
if [[ -d "$RUN_DIR" ]]; then
  while IFS= read -r manifest_path; do
    [[ "$(manifest_value "$manifest_path" TASK_ID)" == "$task_id" ]] || continue
    manifest_role="$(manifest_value "$manifest_path" ROLE)"
    manifest_round="$(manifest_value "$manifest_path" ROUND)"
    case "$manifest_role" in
      IMPLEMENTER)
        [[ -n "$first_implementation_manifest" ]] || first_implementation_manifest="$manifest_path"
        latest_implementation_manifest="$manifest_path"
        implementation_manifests["$manifest_round"]="$manifest_path"
        ;;
      REVIEWER)
        review_manifests["$manifest_round"]="$manifest_path"
        ;;
    esac
  done < <(
    find "$RUN_DIR" -maxdepth 1 -type f -printf '%T@ %p\n' 2>/dev/null |
      sort -n |
      cut -d' ' -f2-
  )
fi

manifest_cycle_base=""
if [[ -n "$first_implementation_manifest" ]]; then
  manifest_cycle_base="$(manifest_value "$first_implementation_manifest" BASE_COMMIT)"
fi
if [[ -n "$manifest_cycle_base" ]] && \
   cycle_base="$(git -C "$ROOT_DIR" rev-parse "$manifest_cycle_base^{commit}" 2>/dev/null)"; then
  :
else
  round_one_commit="$(
    git -C "$ROOT_DIR" log -n 1 --format='%H' \
      --grep='^agent: implementation round 1$' HEAD 2>/dev/null
  )"
  if [[ -n "$round_one_commit" ]] && \
     cycle_base="$(git -C "$ROOT_DIR" rev-parse "$round_one_commit^" 2>/dev/null)"; then
    :
  else
    cycle_base="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  fi
fi

declare -A implementation_commits=()
declare -A review_commits=()
while IFS=$'\t' read -r commit subject; do
  if [[ "$subject" =~ ^agent:\ implementation\ round\ ([0-9]+)$ ]]; then
    implementation_commits["${BASH_REMATCH[1]}"]="$commit"
  elif [[ "$subject" =~ ^agent:\ (codex\ )?review\ round\ ([0-9]+)$ ]]; then
    review_commits["${BASH_REMATCH[2]}"]="$commit"
  fi
done < <(
  git -C "$ROOT_DIR" log --reverse --format='%H%x09%s' "$cycle_base..HEAD" 2>/dev/null
)

stop_stage="$(stop_value STAGE)"
stop_reason="$(stop_value STOP_REASON)"
stop_exit="$(stop_value EXIT_CODE)"
stop_time="$(stop_value STOPPED_AT_UTC)"
display_rounds="$current_round"
if [[ "$stop_stage" == "IMPLEMENTER" || "$stop_stage" == "CLAUDE" ]] && \
   (( current_round < max_rounds )); then
  display_rounds=$((current_round + 1))
fi
(( display_rounds > 0 )) || display_rounds=1
(( display_rounds <= max_rounds )) || display_rounds="$max_rounds"

{
  printf '# Agent 循环简报\n\n'
  printf -- '- 生成时间：`%s`\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- 任务：`%s`\n' "${task_id:-unknown}"
  printf -- '- 当前状态：`%s`\n' "${task_status:-unknown}"
  printf -- '- 已完成审查：`%s/%s`\n' "$current_round" "$max_rounds"
  printf -- '- 最新结论：`%s`\n' "${last_verdict:-NOT_REVIEWED}"
  printf -- '- 本轮基准提交：`%s`\n' "$cycle_base"
  if [[ -n "$CYCLE_EXIT" ]]; then
    printf -- '- 父脚本退出码：`%s`\n' "$CYCLE_EXIT"
  fi
  if [[ -n "$stop_reason" ]]; then
    printf -- '- 最近停止：`%s / %s / exit %s`，时间 `%s`\n' \
      "${stop_stage:-unknown}" "$stop_reason" "${stop_exit:-unknown}" "${stop_time:-unknown}"
  fi
  supervisor_status="$(supervisor_value SUPERVISOR_STATUS)"
  if [[ -n "$supervisor_status" ]]; then
    printf -- '- 外层监督：`%s`，阶段 `%s`，额度窗口恢复 `%s` 次，自主切片 `%s` 次，Monitor 模式 `%s`\n' \
      "$supervisor_status" "$(supervisor_value CURRENT_STAGE)" \
      "$(supervisor_value QUOTA_RESUMES)" \
      "$(supervisor_value AUTONOMY_SLICES)" "$(supervisor_value MONITOR_MODE)"
    if [[ -n "$(supervisor_value LAST_MONITOR_ACTION)" ]]; then
      printf -- '- 最近 Monitor 决策：`%s`\n' \
        "$(supervisor_value LAST_MONITOR_ACTION)"
    fi
    if [[ -n "$(supervisor_value RESUME_AT)" ]]; then
      printf -- '- 计划恢复时间：`%s`\n' "$(supervisor_value RESUME_AT)"
    fi
    if [[ -s "$SUPERVISOR_USAGE_LEDGER" ]]; then
      usage_ledger_summary="$(
        node -e '
          const fs = require("fs");
          const totals = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).totals ?? {};
          const value = (key) => Number.isFinite(totals[key]) ? totals[key] : 0;
          process.stdout.write(
            `runs ${value("runs")}, turns ${value("turns")}, ` +
            `API-equivalent $${value("totalCostUsd").toFixed(2)}, ` +
            `cache-read ${value("cachedInputTokens")}, output ${value("outputTokens")}`,
          );
        ' "$SUPERVISOR_USAGE_LEDGER" 2>/dev/null
      )"
      [[ -n "$usage_ledger_summary" ]] && \
        printf -- '- 当前监督窗口累计用量：`%s`\n' "$usage_ledger_summary"
    fi
  fi
  printf -- '- 默认 IMPLEMENTER：`%s / %s / %s`\n' \
    "$(runtime_value IMPLEMENTER_AGENT)" "$(runtime_value IMPLEMENTER_MODEL)" \
    "$(runtime_value IMPLEMENTER_EFFORT)"
  printf -- '- 默认 REVIEWER：`%s / %s / %s`\n\n' \
    "$(runtime_value REVIEWER_AGENT)" "$(runtime_value REVIEWER_MODEL)" \
    "$(runtime_value REVIEWER_EFFORT)"

  for ((round = 1; round <= display_rounds; round++)); do
    printf '## 第 %s 轮\n\n' "$round"
    implementation_commit="${implementation_commits[$round]:-}"
    review_commit="${review_commits[$round]:-}"

    printf '### IMPLEMENTER\n\n'
    implementation_manifest="${implementation_manifests[$round]:-}"
    if [[ -n "$implementation_commit" ]] && \
       git -C "$ROOT_DIR" show "$implementation_commit:.agent/implementation-report.md" \
         >"$report_tmp" 2>/dev/null; then
      implementer_runtime="$(
        sed -n 's/^- Implementer runtime: *//p' "$report_tmp" | head -n 1 | tr -d '`'
      )"
      printf -- '- 实际运行：`%s`\n' "${implementer_runtime:-未记录（旧格式）}"
      printf -- '- 提交：`%s`\n' "$implementation_commit"
      printf -- '- 改动文件：%s\n' "$(join_changed_files "$implementation_commit")"
      printf -- '- 主要改动：\n'
      change_count=0
      while IFS= read -r change_title; do
        [[ -n "$change_title" ]] || continue
        printf '  - %s\n' "$change_title"
        change_count=$((change_count + 1))
      done < <(report_change_titles "$report_tmp")
      if (( change_count == 0 )); then
        printf '  - 详见该提交中保存的实现报告。\n'
      fi
      validation="$(sed -n 's/^- Unified validation: //p' "$report_tmp" | tail -n 1)"
      [[ -n "$validation" ]] && printf -- '- 验证：%s\n' "$validation"
      printf -- '- 详细报告：`git show %s:.agent/implementation-report.md`\n' \
        "$implementation_commit"
    elif [[ "$stop_stage" == "IMPLEMENTER" || "$stop_stage" == "CLAUDE" ]] && \
         [[ "$round" == "$((current_round + 1))" ]]; then
      if [[ -n "$latest_implementation_manifest" ]]; then
        printf -- '- 实际运行：`%s / %s / %s`\n' \
          "$(manifest_value "$latest_implementation_manifest" EXECUTOR)" \
          "$(manifest_value "$latest_implementation_manifest" MODEL)" \
          "$(manifest_value "$latest_implementation_manifest" EFFORT)"
      fi
      printf -- '- 结果：形成有效实现检查点前中断。\n'
      printf -- '- 停止原因：`%s`（退出码 `%s`）\n' \
        "${stop_reason:-unknown}" "${stop_exit:-unknown}"
      dirty_status="$(git -C "$ROOT_DIR" status --short)"
      if [[ -n "$dirty_status" ]]; then
        printf -- '- 保留的未提交文件：\n\n```text\n%s\n```\n' "$dirty_status"
      fi
      printf -- '- 运行清单与日志：`.agent/artifacts/runs/`、`.agent/artifacts/implementation/`\n'
    else
      printf -- '- 未运行，或没有形成有效检查点。\n'
    fi
    if [[ -n "$implementation_manifest" && \
          -n "$(manifest_value "$implementation_manifest" SESSION_MODE)" ]]; then
      printf -- '- 会话：`%s`，模式 `%s`\n' \
        "$(manifest_value "$implementation_manifest" RESOLVED_SESSION_ID)" \
        "$(manifest_value "$implementation_manifest" SESSION_MODE)"
      printf -- '- 会话代次：`%s`；Claude 保险：turns `%s`，budget `$%s`\n' \
        "$(manifest_value "$implementation_manifest" SESSION_GENERATION)" \
        "$(manifest_value "$implementation_manifest" MAX_TURNS)" \
        "$(manifest_value "$implementation_manifest" MAX_BUDGET_USD)"
      printf -- '- 用量记录：`%s`\n' \
        "$(manifest_value "$implementation_manifest" USAGE_FILE)"
    fi
    printf '\n'

    printf '### REVIEWER\n\n'
    review_manifest="${review_manifests[$round]:-}"
    if [[ -n "$review_commit" ]] && \
       git -C "$ROOT_DIR" show "$review_commit:.agent/latest-review.md" \
         >"$report_tmp" 2>/dev/null; then
      reviewer_runtime="$(
        sed -n 's/^- Reviewer runtime: *//p' "$report_tmp" | head -n 1 | tr -d '`'
      )"
      verdict="$(sed -n 's/^VERDICT: //p' "$report_tmp" | head -n 1)"
      reviewed_commit="$(sed -n 's/^- Reviewed commit: //p' "$report_tmp" | head -n 1)"
      printf -- '- 实际运行：`%s`\n' "${reviewer_runtime:-未记录（旧格式）}"
      printf -- '- 审查提交：`%s`\n' "$review_commit"
      printf -- '- 审查的实现提交：`%s`\n' "${reviewed_commit:-unknown}"
      printf -- '- 结论：`%s`\n' "${verdict:-unknown}"
      finding_count=0
      while IFS=$'\t' read -r severity finding_title; do
        [[ -n "$finding_title" ]] || continue
        if (( finding_count == 0 )); then printf -- '- 发现的问题：\n'; fi
        printf '  - **%s** — %s\n' "$severity" "$finding_title"
        finding_count=$((finding_count + 1))
      done < <(report_findings "$report_tmp")
      if (( finding_count == 0 )); then printf -- '- 发现的问题：无。\n'; fi
      printf -- '- 详细报告：`git show %s:.agent/latest-review.md`\n' "$review_commit"
    else
      printf -- '- 未运行。\n'
    fi
    if [[ -n "$review_manifest" && \
          -n "$(manifest_value "$review_manifest" SESSION_MODE)" ]]; then
      printf -- '- 会话：`%s`，模式 `%s`\n' \
        "$(manifest_value "$review_manifest" RESOLVED_SESSION_ID)" \
        "$(manifest_value "$review_manifest" SESSION_MODE)"
      printf -- '- 会话代次：`%s`；Claude 保险：turns `%s`，budget `$%s`\n' \
        "$(manifest_value "$review_manifest" SESSION_GENERATION)" \
        "$(manifest_value "$review_manifest" MAX_TURNS)" \
        "$(manifest_value "$review_manifest" MAX_BUDGET_USD)"
      printf -- '- 用量记录：`%s`\n' \
        "$(manifest_value "$review_manifest" USAGE_FILE)"
    fi
    printf '\n'
  done

  printf '## 接下来怎么做\n\n'
  if [[ "$task_status" == "COMPLETE" && "$last_verdict" == "PASS" ]]; then
    printf -- '- 自动循环已经通过；所有者可以进行主观观感与手感验收。\n'
  elif (( current_round >= max_rounds )); then
    printf -- '- 已达到轮数上限；启动新循环前请先作出产品或技术决定。\n'
  elif [[ -n "$stop_reason" ]]; then
    if [[ "$supervisor_status" == "AWAITING_MONITOR_ACTION" ]]; then
      printf -- '- 工作 Agent 已退出；由附着式 Monitor 根据用量提交下一动作。\n'
    elif [[ "$supervisor_status" == "WAITING_FOR_QUOTA" || \
          "$supervisor_status" == "WAITING_FOR_BUDGET_WINDOW" || \
          "$supervisor_status" == "SCHEDULED" ]]; then
      printf -- '- 外层监督器已安排恢复；无需保持 AI Agent 轮询。\n'
    else
      printf -- '- 先解决停止原因 `%s`，恢复前再次检查工作区。\n' "$stop_reason"
    fi
  else
    printf -- '- 从最新正式审查问题继续下一轮实现。\n'
  fi
  printf -- '- 完整状态：`./scripts/agent-cycle.sh status`\n'
  printf -- '- 监督状态：`./scripts/agent-cycle.sh supervisor-status`\n'
  printf -- '- 调用审计：`.agent/artifacts/runs/`\n'
  printf -- '- 重新生成简报：`./scripts/agent-cycle.sh summary`\n'
} >"$summary_tmp"

install -m 0644 "$summary_tmp" "$OUTPUT_FILE"
history_file="$HISTORY_DIR/$(date -u +'%Y-%m-%dT%H%M%SZ')_${task_slug}.md"
if [[ ! -e "$history_file" ]]; then
  install -m 0644 "$summary_tmp" "$history_file"
fi

printf '%s\n' "$OUTPUT_FILE"
