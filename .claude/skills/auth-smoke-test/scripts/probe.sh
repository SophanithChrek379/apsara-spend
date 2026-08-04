#!/usr/bin/env bash
#
# Auth smoke test for apsara-spend.
#
# Exercises every part of the account system that can be checked without a
# browser: project configuration, the anonymous session, RLS isolation, and
# whether Google linking is actually reachable.
#
# Cannot drive Google's consent screen. Everything up to the redirect is
# checked here; what happens after it is the manual checklist in SKILL.md.
#
# Usage:
#   probe.sh
#
# Optional: export SUPABASE_SERVICE_ROLE_KEY to auto-delete the throwaway users
# this script creates. Without it their ids are printed for manual deletion.

set -uo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/.env.local"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

PASS=0; FAIL=0; WARN=0
TEST_UIDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ok()   { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; [[ $# -gt 1 ]] && printf '      %s%s%s\n' "$DIM" "$2" "$OFF"; }
warn() { WARN=$((WARN+1)); printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

jqf() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for k in sys.argv[1].split('.'):
    if isinstance(d,dict): d=d.get(k)
    else: d=None
print('' if d is None else d)" "$1" 2>/dev/null; }

# ── credentials ─────────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || { echo "${RED}No .env.local at $ENV_FILE${OFF}"; exit 1; }
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' \r')
KEY=$(grep -E '^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' \r')
[[ -n "$URL" && -n "$KEY" ]] || { echo "${RED}URL or publishable key missing from .env.local${OFF}"; exit 1; }

printf '%sapsara-spend · auth smoke test%s\n%s%s%s\n' "$BOLD" "$OFF" "$DIM" "$URL" "$OFF"

# ── 1. project configuration ────────────────────────────────────────────────
head_ "1. Project configuration"
SETTINGS=$(curl -sS -H "apikey: $KEY" "$URL/auth/v1/settings")
if [[ -z "$SETTINGS" ]]; then
  bad "cannot reach the auth API" "check the URL and your connection"
else
  [[ $(echo "$SETTINGS" | jqf external.anonymous_users) == "True" ]] \
    && ok "anonymous sign-ins enabled" \
    || bad "anonymous sign-ins DISABLED" "the app cannot mint a session; every visitor stays cache-only"
  [[ $(echo "$SETTINGS" | jqf external.google) == "True" ]] \
    && ok "Google provider enabled" \
    || bad "Google provider DISABLED" "the only way in is gone; nobody can sign up or log in"
  [[ $(echo "$SETTINGS" | jqf disable_signup) == "False" ]] \
    && ok "signups allowed" \
    || warn "signups disabled project-wide"
fi

# ── 2. anonymous session ────────────────────────────────────────────────────
head_ "2. Anonymous session"
ANON=$(curl -sS -X POST -H "apikey: $KEY" -H "Content-Type: application/json" -d '{"data":{}}' "$URL/auth/v1/signup")
TOK=$(echo "$ANON" | jqf access_token)
ANON_UID=$(echo "$ANON" | jqf user.id)
if [[ -n "$TOK" && -n "$ANON_UID" ]]; then
  TEST_UIDS+=("$ANON_UID")
  ok "signed in anonymously (${ANON_UID:0:8}…)"
  [[ $(echo "$ANON" | jqf user.is_anonymous) == "True" ]] \
    && ok "is_anonymous flag set" \
    || bad "is_anonymous is not true" "the Settings panel keys 'backed up' off this"
else
  bad "anonymous sign-in failed" "$(echo "$ANON" | head -c 200)"
fi

# ── 3. row level security ───────────────────────────────────────────────────
head_ "3. Row Level Security"
if [[ -n "$TOK" ]]; then
  NOTE="__probe_$$"
  INS=$(curl -sS -X POST -H "apikey: $KEY" -H "Authorization: Bearer $TOK" \
        -H "Content-Type: application/json" -H "Prefer: return=representation" \
        -d "{\"amount_usd\":1.00,\"category\":\"misc\",\"note\":\"$NOTE\",\"spent_on\":\"2026-01-01\"}" \
        "$URL/rest/v1/transactions")
  ROW_UID=$(echo "$INS" | python3 -c "import json,sys
try: print(json.load(sys.stdin)[0]['user_id'])
except Exception: print('')" 2>/dev/null)

  if [[ "$ROW_UID" == "$ANON_UID" ]]; then
    ok "insert succeeded, user_id defaulted to auth.uid()"
  else
    bad "insert failed or user_id is wrong" "$(echo "$INS" | head -c 200)"
  fi

  MINE=$(curl -sS -H "apikey: $KEY" -H "Authorization: Bearer $TOK" \
         "$URL/rest/v1/transactions?select=id&note=eq.$NOTE" | tr -cd '{' | wc -c | tr -d ' ')
  [[ "$MINE" == "1" ]] && ok "own row readable" || bad "expected 1 own row, saw $MINE"

  ANONREAD=$(curl -sS -H "apikey: $KEY" "$URL/rest/v1/transactions?select=id&note=eq.$NOTE")
  [[ "$ANONREAD" == "[]" ]] \
    && ok "unauthenticated read blocked" \
    || bad "UNAUTHENTICATED READ RETURNED DATA" "RLS is not protecting transactions: $(echo "$ANONREAD" | head -c 120)"

  DEL=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "apikey: $KEY" -H "Authorization: Bearer $TOK" \
        "$URL/rest/v1/transactions?note=eq.$NOTE")
  [[ "$DEL" == "204" ]] && ok "test row deleted" || warn "cleanup of test row returned $DEL"
else
  warn "skipped — no anonymous session"
fi

# ── 4. Google linking reachable ─────────────────────────────────────────────
head_ "4. Google linking"
if [[ -n "$TOK" ]]; then
  LINK=$(curl -sS -H "apikey: $KEY" -H "Authorization: Bearer $TOK" \
         "$URL/auth/v1/user/identities/authorize?provider=google&skip_http_redirect=true")
  LCODE=$(echo "$LINK" | jqf error_code)
  LURL=$(echo "$LINK" | jqf url)

  if [[ "$LCODE" == "manual_linking_disabled" ]]; then
    bad "manual linking is DISABLED" "Sign up and 'Also sign in with Google' both fail; only log-in works. Authentication → Sign In / Providers → User Signups"
  elif [[ -n "$LURL" ]]; then
    ok "linkIdentity reachable — Google returns an authorize URL"
    [[ "$LURL" == *"redirect_uri=https%3A%2F%2F"* ]] \
      && ok "callback points at Supabase, as Google Cloud expects" \
      || warn "unexpected redirect_uri in the authorize URL"
    [[ "$LURL" == *"scope=email"* ]] \
      && ok "email scope requested (Settings needs it to show the address)" \
      || warn "email scope missing — account.email will stay null"
  else
    bad "linkIdentity failed" "$(echo "$LINK" | head -c 200)"
  fi
else
  warn "skipped — no anonymous session"
fi

# ── cleanup ─────────────────────────────────────────────────────────────────
head_ "Cleanup"
if [[ ${#TEST_UIDS[@]} -eq 0 ]]; then
  printf '  %snothing to clean up%s\n' "$DIM" "$OFF"
elif [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  for u in "${TEST_UIDS[@]}"; do
    C=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        "$URL/auth/v1/admin/users/$u")
    [[ "$C" == "200" ]] && ok "deleted throwaway user ${u:0:8}…" || warn "could not delete $u (HTTP $C)"
  done
else
  warn "${#TEST_UIDS[@]} throwaway user(s) left behind — delete in Authentication → Users:"
  for u in "${TEST_UIDS[@]}"; do printf '      %s\n' "$u"; done
  printf '      %sor export SUPABASE_SERVICE_ROLE_KEY to have this script remove them%s\n' "$DIM" "$OFF"
fi

# ── verdict ─────────────────────────────────────────────────────────────────
printf '\n%s%d passed · %d failed · %d warnings%s\n' "$BOLD" "$PASS" "$FAIL" "$WARN" "$OFF"
[[ $FAIL -eq 0 ]] || exit 1
