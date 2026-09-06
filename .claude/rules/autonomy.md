# Autonomy boundary — how far to run without asking

Set by the user on 2026-09-06. Applies session-wide, not just inside the
`dev-loop` skill: once a task is underway, keep going through it — analysis,
implementation, and verification — without stopping to ask "should I
continue?" or "is this ok?", except for the cases below.

## Proceed without asking

- Reading or searching any file in the repo.
- Editing or creating files under `app/`, `components/`, `lib/`, `.claude/`,
  etc. as needed to implement the requested change.
- Local verification: `npm run build`, `npm run lint`, `npx tsc --noEmit`,
  starting/stopping the local dev server, `curl` against `localhost`, the
  `run-app` headless render check, the `auth-smoke-test` skill.
- Iterating — fix, re-run checks, fix again — as many rounds as it takes,
  without checking in after each one (see the stuck-loop cap below).
- Spawning the `analyst` subagent, or `Explore`/`Plan`, for research.

## Stop and ask first

Reserved for things that are hard to reverse, touch shared or external state,
or are security-sensitive:

- `git push` (including force-push), deleting branches, amending or
  rewriting already-published commits.
- Installing, removing, or upgrading a dependency — anything that would
  change `package.json`/`package-lock.json`. This includes `npx shadcn add`
  when the component would pull in a new Radix package.
- Any change to `.env*`, Supabase project/auth settings, RLS policies, Google
  OAuth client config, or the `permissions` block in `.claude/settings.json`
  itself.
- Anything that sends data outside the user's machine beyond what the task
  explicitly asked for (external API calls with real credentials, posting to
  Slack/GitHub/etc.).
- Git commits — unchanged from the standing project-wide rule: only commit
  when the user explicitly asks, loop or no loop.

## Stuck is not the same as insecure, but say so anyway

If the same build/lint/test failure survives about five fix attempts in a
row, stop looping and report what's failing and what's already been tried,
instead of continuing to guess. This isn't a security exception — it's just
that a loop that can't tell it's stuck isn't actually autonomous, it's just
quiet. A task can legitimately end in "here's what's blocking it," not just
"done."

## Manual verification checkpoint

This project has no automated UI/E2E test runner (see the `run-app` skill).
For any user-visible change, once `npm run lint` / `npm run build` pass (and
the optional headless render check, if it was worth running), stop and tell
the user it's ready to check — they'll drive it themselves using the Claude
extension in Brave, already signed into this account. Don't attempt to
control that extension programmatically; no tool for it is wired into this
session. Handing off for a look isn't the same as asking permission to
continue — it's the one deliberate human-in-the-loop step in this flow.
