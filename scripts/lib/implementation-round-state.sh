#!/usr/bin/env bash

# Neutral state transitions for one implementation round.
#
# A round may span several Agent processes and recovery commits. The review
# base is therefore anchored before the first process starts and must not be
# recomputed from a later recovery checkpoint.

AGENT_IMPLEMENTATION_REVIEW_BASE=""
AGENT_IMPLEMENTATION_ANCHOR_COMMIT=""
AGENT_IMPLEMENTATION_ANCHOR_CREATED="NO"

agent_state_value_from_file() {
  local state_file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$state_file" | head -n 1
}

agent_prepare_implementation_round_anchor() {
  local root_dir="$1"
  local state_file="$2"
  local implementation_round="$3"
  local active_round active_base initial_base state_tmp
  local state_relative

  AGENT_IMPLEMENTATION_REVIEW_BASE=""
  AGENT_IMPLEMENTATION_ANCHOR_COMMIT=""
  AGENT_IMPLEMENTATION_ANCHOR_CREATED="NO"

  [[ "$implementation_round" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Invalid implementation round for review-base anchor: %s\n' \
      "$implementation_round" >&2
    return 2
  }
  [[ -s "$state_file" ]] || {
    printf 'Agent state file is missing or empty: %s\n' "$state_file" >&2
    return 2
  }

  active_round="$(
    agent_state_value_from_file "$state_file" ACTIVE_IMPLEMENTATION_ROUND
  )"
  active_base="$(
    agent_state_value_from_file \
      "$state_file" ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT
  )"

  if [[ -n "$active_round" || -n "$active_base" ]]; then
    if [[ "$active_round" != "$implementation_round" || -z "$active_base" ]]; then
      printf 'Inconsistent active implementation anchor: round=%s base=%s; expected round %s.\n' \
        "${active_round:-missing}" "${active_base:-missing}" \
        "$implementation_round" >&2
      return 4
    fi
    active_base="$(
      git -C "$root_dir" rev-parse --verify "$active_base^{commit}" 2>/dev/null
    )" || {
      printf 'Active implementation review base is not a commit: %s\n' \
        "$active_base" >&2
      return 4
    }
    if ! git -C "$root_dir" merge-base --is-ancestor \
      "$active_base" HEAD; then
      printf 'Active implementation review base is not an ancestor of HEAD: %s\n' \
        "$active_base" >&2
      return 4
    fi
    AGENT_IMPLEMENTATION_REVIEW_BASE="$active_base"
    AGENT_IMPLEMENTATION_ANCHOR_COMMIT="$(
      git -C "$root_dir" rev-parse HEAD
    )"
    return 0
  fi

  if [[ -n "$(git -C "$root_dir" status --porcelain --untracked-files=all)" ]]; then
    printf 'Cannot anchor an implementation round in a dirty worktree.\n' >&2
    return 2
  fi

  initial_base="$(git -C "$root_dir" rev-parse HEAD)" || return 2
  state_tmp="${state_file}.round-anchor.tmp"
  while IFS= read -r state_line; do
    case "$state_line" in
      ACTIVE_IMPLEMENTATION_ROUND=*|ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT=*) ;;
      *) printf '%s\n' "$state_line" ;;
    esac
  done <"$state_file" >"$state_tmp"
  {
    printf 'ACTIVE_IMPLEMENTATION_ROUND=%s\n' "$implementation_round"
    printf 'ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT=%s\n' "$initial_base"
  } >>"$state_tmp"
  mv "$state_tmp" "$state_file"

  state_relative="${state_file#"$root_dir/"}"
  if ! git -C "$root_dir" add -- "$state_relative"; then
    printf 'Could not stage the implementation round anchor.\n' >&2
    return 4
  fi
  if ! git -C "$root_dir" \
    -c core.hooksPath=/dev/null \
    -c commit.gpgSign=false \
    commit -m "agent: begin implementation round $implementation_round"; then
    printf 'Could not checkpoint the implementation round anchor.\n' >&2
    return 4
  fi

  AGENT_IMPLEMENTATION_REVIEW_BASE="$initial_base"
  AGENT_IMPLEMENTATION_ANCHOR_COMMIT="$(
    git -C "$root_dir" rev-parse HEAD
  )"
  AGENT_IMPLEMENTATION_ANCHOR_CREATED="YES"
}

agent_finish_implementation_round_state() {
  local state_file="$1"
  local implementation_round="$2"
  local review_base_commit="$3"
  local implementer_agent="$4"
  local implementer_model="$5"
  local implementer_effort="$6"
  local active_round active_base state_tmp

  active_round="$(
    agent_state_value_from_file "$state_file" ACTIVE_IMPLEMENTATION_ROUND
  )"
  active_base="$(
    agent_state_value_from_file \
      "$state_file" ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT
  )"
  if [[ "$active_round" != "$implementation_round" || \
        "$active_base" != "$review_base_commit" ]]; then
    printf 'Implementation completion does not match its anchored review base.\n' >&2
    printf 'Expected round/base: %s / %s\n' \
      "$active_round" "$active_base" >&2
    printf 'Actual round/base:   %s / %s\n' \
      "$implementation_round" "$review_base_commit" >&2
    return 4
  fi

  state_tmp="${state_file}.implementation-finish.tmp"
  while IFS= read -r state_line; do
    case "$state_line" in
      CURRENT_ROUND=*|ACTIVE_TASK_STATUS=*|PENDING_REVIEW=*|PENDING_REVIEW_ROUND=*|PENDING_REVIEW_BASE_COMMIT=*|LAST_IMPLEMENTATION_BASE_COMMIT=*|LAST_IMPLEMENTER_AGENT=*|LAST_IMPLEMENTER_MODEL=*|LAST_IMPLEMENTER_EFFORT=*|ACTIVE_IMPLEMENTATION_ROUND=*|ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT=*) ;;
      *) printf '%s\n' "$state_line" ;;
    esac
  done <"$state_file" >"$state_tmp"
  {
    printf 'CURRENT_ROUND=%s\n' "$implementation_round"
    printf 'ACTIVE_TASK_STATUS=AWAITING_OWNER\n'
    printf 'PENDING_REVIEW=YES\n'
    printf 'PENDING_REVIEW_ROUND=%s\n' "$implementation_round"
    printf 'PENDING_REVIEW_BASE_COMMIT=%s\n' "$review_base_commit"
    printf 'LAST_IMPLEMENTATION_BASE_COMMIT=%s\n' "$review_base_commit"
    printf 'LAST_IMPLEMENTER_AGENT=%s\n' "$implementer_agent"
    printf 'LAST_IMPLEMENTER_MODEL=%s\n' "$implementer_model"
    printf 'LAST_IMPLEMENTER_EFFORT=%s\n' "$implementer_effort"
    printf 'ACTIVE_IMPLEMENTATION_ROUND=\n'
    printf 'ACTIVE_IMPLEMENTATION_REVIEW_BASE_COMMIT=\n'
  } >>"$state_tmp"
  mv "$state_tmp" "$state_file"
}
