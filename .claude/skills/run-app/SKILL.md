---
name: run-app
description: Build and run apsara-spend locally — dev server, production build, and a headless-browser render check. Use when asked to run, start, build, or screenshot the app, or to confirm a change works for real (not just typecheck/lint).
---

# Running apsara-spend

Next.js 16 app, Turbopack by default. Needs `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local` — already present in
this repo checkout.

## Build

```bash
npm run build
```

Should finish with a route table (`/`, `/api/budgets`, `/api/ledger`,
`/api/sync`, `/api/transactions`, `/api/transactions/[id]`). No `--webpack`
flag needed if the gotcha below is already fixed.

## Dev server

```bash
npm run dev &
timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 1; done'
```

Confirms with:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

Stop it with the port, not `$!` — npm's wrapper doesn't forward signals to
the child:

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
```

## Gotcha: missing Turbopack native binary (Intel Mac)

On darwin/x64, `npm run build`/`npm run dev` can fail with:

```
Turbopack is not supported on this platform (darwin/x64) because native
bindings are not available. Only WebAssembly (WASM) bindings were loaded...
```

Cause: `node_modules/@next/swc-darwin-x64/` exists but is missing its
`next-swc.darwin-x64.node` binary (~114MB) — an interrupted or corrupted
`npm install`, not a code issue. Check:

```bash
find node_modules/@next/swc-darwin-x64 -name '*.node'
```

If empty, force a clean reinstall of just that package:

```bash
rm -rf node_modules/@next/swc-darwin-x64
npm install @next/swc-darwin-x64@<version-matching-next> --no-save --force
```

Match `<version>` to the installed `next` version (`npm ls next`). Don't add
`--webpack` as a workaround — fix the binary, Turbopack is the intended path.

## Optional: visual render check

`chromium-cli` is not available in this environment. Fall back to Playwright,
installed to a scratch dir so it never touches this project's
`package.json`/`node_modules`:

```bash
cd <scratchpad>
npx --yes playwright install --with-deps chromium   # first time only, ~2-5 min
```

Then a one-off script (`node script.js`) using `require('playwright')` via
`npx playwright`... in practice, simplest is `npx --yes playwright screenshot
http://localhost:3000 out.png` after the browser is installed, or a short
inline script with `chromium.launch()` → `page.goto()` → `page.screenshot()`
for anything needing interaction (login, clicks). The app requires Google
OAuth (see [auth-smoke-test](../auth-smoke-test/SKILL.md)) — Playwright can't
drive Google's consent screen, so this only proves the anonymous-session
landing page renders, not a signed-in state.

Skip this step unless the user asks for visual confirmation — build success
+ the curl check above is normally sufficient proof the app runs.
