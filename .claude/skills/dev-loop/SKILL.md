---
name: dev-loop
description: Drive a task end-to-end without stopping for approval between steps — scope it, implement it, then verify with lint/build (and run-app / auth-smoke-test when relevant), looping fixes until checks pass. Use when the user wants a task carried to completion autonomously — "just build this," "loop until it's done," "don't check in with me at each step." See .claude/rules/autonomy.md for the small set of things that still stop the loop.
---

# dev-loop

Three phases, run back to back in one sitting. Don't pause between them for a
yes/no unless [autonomy.md](../../rules/autonomy.md) says this particular
thing is one of the cases to stop for.

## 1. Analyst

- For anything beyond a trivial single-file change, spawn the `analyst`
  subagent with the task description. It's read-only — it reports back
  affected files, which project rules/skills apply, an ordered implementation
  plan, and which verification steps are needed. It does not edit anything.
- For an obviously-scoped one-file change, skip the subagent — one or two
  sentences of plan is enough before editing.
- This is internal scoping, not a plan-approval gate. Don't call
  `ExitPlanMode` as part of this flow — that stops and waits for a yes, which
  is exactly what this skill exists to avoid. Save `ExitPlanMode` for when the
  user asked for a plan to review, not for autonomous execution.

## 2. Implement

- Make the changes the plan calls for. Project rules apply automatically —
  `ui-styling.md` for anything under `app/**/*.tsx` or `components/**/*.tsx`,
  the `shadcn-ui` skill for new or restyled UI.
- Work through everything the plan touches without checking in mid-way.

## 3. Test, loop, verify

- Run `npm run lint` and `npm run build`. This project has no `npm test` —
  `build` is also the type-check, since it runs `tsc` as part of the Next.js
  build.
- Touched auth/Supabase/RLS/OAuth? Run the `auth-smoke-test` skill.
- Touched anything user-visible? Use `run-app` to confirm the dev server
  actually serves it. Its optional headless render check costs a Playwright
  install — worth it for a real visual regression risk, skippable otherwise
  (see that skill for the tradeoff).
- On failure: fix, re-run, repeat. If the *same* failure survives about five
  rounds, stop and report what's failing and what's been tried — see the
  stuck-loop note in `autonomy.md`. Don't silently keep guessing past that.
- Once everything's green: tell the user what changed and that it's ready for
  them to click through in Brave with their Claude extension (already signed
  into this account). That handoff is the one deliberate stop in this flow —
  there's no tool wired up to drive that extension, so don't attempt to.
