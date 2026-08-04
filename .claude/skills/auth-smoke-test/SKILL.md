---
name: auth-smoke-test
description: Verify the account system end to end — anonymous sessions, RLS isolation, Google sign-up and log-in, and identity linking. Use before shipping any auth change, after touching Supabase or Google Cloud settings, when a user reports "I can't sign in" or "my data disappeared after logging in", or when checking whether the project is ready for real users.
---

# Testing accounts in apsara-spend

Google is the only way in. Email + OTP was removed — accounts created under it
keep working, but nothing in the app can send a code any more.

Two halves. The script covers everything reachable from a terminal; the
checklist covers what needs a real browser. Run both — the script passing does
not mean a user can sign in.

## 1. Automated pass

```bash
bash .claude/skills/auth-smoke-test/scripts/probe.sh
```

Checks, in order:

| # | What | Why it matters |
|---|---|---|
| 1 | anonymous sign-ins, Google provider | Google off is total — there is no second way in to fall back to |
| 2 | anonymous sign-in + `is_anonymous` | Settings keys "signed in" off this flag |
| 3 | insert, read-own, **unauthenticated read**, delete | the unauthenticated read is the one that matters — it must return `[]` |
| 4 | `linkIdentity` authorize, callback host, `email` scope | manual linking off breaks Sign up while log-in still works, which reads as "half the app is broken" |

Exits non-zero if anything fails. Warnings are configuration gaps, not bugs.

### Cleanup

The script creates throwaway anonymous users. It deletes its own rows, but
deleting a *user* needs admin rights:

```bash
export SUPABASE_SERVICE_ROLE_KEY=...   # Project Settings → API Keys
```

Without it the uids are printed for manual deletion in **Authentication →
Users**. Never commit that key or put it in `.env.local` — it bypasses RLS.

## 2. What the script cannot do

**It cannot drive OAuth.** Google's consent screen is a real browser flow.
Everything up to the redirect is checked; everything after it is section 3.

**It cannot tell a linked account from a separate one.** Two users can both
hold the same address — one via an old `email` identity, one via Google. The
app looks fine and the ledger looks empty. Only the SQL in section 4 shows it.

## 3. Manual pass

Run `npm run dev`, then work through these in order. G4 and G3 are the ones
that lose data when they regress, so never skip them.

| # | Do this | Expect |
|---|---|---|
| **G4** | Settings → **Sign up** → Continue with Google → **cancel** at the consent screen | back on the same anonymous session, **entries untouched**, no error toast |
| **G1** | 2–3 entries → **Sign up** → Continue with Google → approve | returns signed in, **all entries still there**, toast names the address |
| **G2** | Clear site data → reload → **Log in** → Google | entries pull back down |
| **G3** | Other browser with its own entries → **Log in** → Google | local entries **replaced**, never merged |
| **G5** | Signed in already → Settings → **Also sign in with Google** | links without signing out; the row disappears afterwards |
| **G6** | Second Google account → **Sign up** on a device already signed in | "already linked to a different account", no silent failure |
| **G7** | Airplane mode → Continue with Google | "You're offline", not a hang |

G4 is the one to watch. The parked OAuth intent is consumed on every boot and
the wipe is gated on *intent AND a changed uid*, precisely because a cancelled
log-in and a completed link both return on the unchanged anonymous uid. If
cancelling ever empties the ledger, that guard has broken — see the boot effect
in [useSyncedLedger.ts](../../../lib/ledger/useSyncedLedger.ts).

## 4. Reading a failure

| Symptom | Look at |
|---|---|
| "Google sign-in isn't available right now" | provider off, or **manual linking** disabled — Authentication → Sign In / Providers → User Signups |
| `redirect_uri_mismatch` from Google | the URI in Google Cloud must be `<project>.supabase.co/auth/v1/callback`, character for character |
| Returns to the app still anonymous, no toast | the user cancelled — that is deliberate silence, not a bug |
| Returns signed in but Settings shows no address | `email` scope missing from the authorize URL; probe step 4 checks this |
| Lands on an empty ledger after log-in | the address is on a *different* uid than the rows. Run the query below before moving anything |
| Data vanished after log-in | expected if that account genuinely holds nothing — rows are still under the old uid, not deleted. `adoptAccount` wipes the *cache*, never the server |

Where the rows actually live:

```sql
select u.id,
       coalesce(u.email, '(anonymous)') as email,
       (select string_agg(i.provider, ',') from auth.identities i where i.user_id = u.id) as providers,
       count(t.id) as entries
from auth.users u
left join public.transactions t on t.user_id = u.id
group by u.id, u.email
order by entries desc;
```

Two rows sharing one address — one with `email`, one with `google` — is the
signature of a split account. Move the rows, don't move the identity.

## 5. Before calling it production-ready

- [ ] `probe.sh` exits 0
- [ ] G1-G7 pass
- [ ] `npx tsc --noEmit` and `npm run build` clean
- [ ] Google consent screen **published**, not left in Testing (Testing caps you
      at the test users you listed by hand)
- [ ] `NEXT_PUBLIC_SUPABASE_*` set in Vercel, and redeployed since
- [ ] no throwaway test users left in Authentication → Users
