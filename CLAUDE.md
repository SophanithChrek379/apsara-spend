# apsara-spend

Next.js 16 + Supabase spend tracker. Tailwind CSS v4 (no config file — theme
lives in `@theme` inside [app/globals.css](app/globals.css)) and shadcn/ui
(new-york, `--ui-*` prefixed tokens).

## Rules

@.claude/rules/ui-styling.md

For building or migrating UI, follow the `shadcn-ui` skill in
[.claude/skills/shadcn-ui/](.claude/skills/shadcn-ui/).

For anything touching accounts — anonymous sessions, email + OTP, Google OAuth,
RLS — verify with the `auth-smoke-test` skill in
[.claude/skills/auth-smoke-test/](.claude/skills/auth-smoke-test/).

To build or run the app locally, follow the `run-app` skill in
[.claude/skills/run-app/](.claude/skills/run-app/).
