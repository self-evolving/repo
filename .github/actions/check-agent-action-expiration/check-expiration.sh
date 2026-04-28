#!/usr/bin/env bash
set -euo pipefail

expires_at="${INPUT_EXPIRES_AT:-}"

fail() {
  echo "::error title=Invalid expiration date::$1" >&2
  exit 2
}

if [[ -z "$expires_at" ]]; then
  fail "expires_at is required and must be formatted as YYYY-MM-DD"
fi

if [[ ! "$expires_at" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]]; then
  fail "expires_at must be formatted as YYYY-MM-DD"
fi

year="${BASH_REMATCH[1]}"
month="${BASH_REMATCH[2]}"
day="${BASH_REMATCH[3]}"

year_num=$((10#$year))
month_num=$((10#$month))
day_num=$((10#$day))

if (( month_num < 1 || month_num > 12 )); then
  fail "expires_at month must be between 01 and 12"
fi

is_leap_year=false
if (( (year_num % 4 == 0 && year_num % 100 != 0) || year_num % 400 == 0 )); then
  is_leap_year=true
fi

case "$month_num" in
  1|3|5|7|8|10|12) max_day=31 ;;
  4|6|9|11) max_day=30 ;;
  2)
    if [[ "$is_leap_year" == "true" ]]; then
      max_day=29
    else
      max_day=28
    fi
    ;;
  *) fail "expires_at month must be between 01 and 12" ;;
esac

if (( day_num < 1 || day_num > max_day )); then
  fail "expires_at day is invalid for the given month"
fi

today="$(date -u +%Y-%m-%d)"
expired=false
if [[ "$today" > "$expires_at" ]]; then
  expired=true
fi

{
  echo "expired=$expired"
  echo "expires_at=$expires_at"
  echo "today=$today"
} >> "$GITHUB_OUTPUT"

if [[ "$expired" == "true" ]]; then
  echo "Agent action expired at $expires_at; skipping."
else
  echo "Agent action is not expired (today: $today, expires: $expires_at)."
fi
