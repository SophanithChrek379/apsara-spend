# UI rule — shadcn/ui + Tailwind only

Applies to every `.tsx` under `app/` and `components/`. Non-negotiable unless the
user overrides it in the request.

## 1. Components come from shadcn/ui

Every interactive element and every composite UI block is a shadcn/ui component
whenever one matches. Do not hand-roll a `<button>`, dropdown, dialog, sheet,
tabs, select, tooltip, toast, or form field that shadcn already ships.

- Missing from `components/ui/`? Add it: `npx shadcn@latest add <name>`.
  Do not paste the source by hand — the CLI wires imports and tokens correctly.
- Match by role, not by looks. A bottom drawer is `sheet` with `side="bottom"`,
  not a custom fixed div. A segmented month picker is `tabs` or `toggle-group`.
- Radix primitives (`radix-ui` is a direct dependency) are the fallback **only**
  when shadcn has no matching component. Wrap the primitive in
  `components/ui/<name>.tsx` in shadcn's own style: `cva` variants,
  `React.forwardRef`, `cn()` merge, `data-slot` attributes.
- Plain HTML is fine for pure layout and text — `div`, `section`, `span`, `p`,
  headings, `ul/li`. Those are not components.

## 2. Styling is Tailwind utility classes only

- No inline `style={{ … }}`. The single exception is a value only known at
  runtime (a computed bar width, a dynamic chart colour) — and then only that
  one property, with the rest of the element still on utilities.
- No `<style>` / `<style jsx>` blocks in components. No CSS modules. No
  styled-components. No `.css` file next to a component.
- Compose conditionals with `cn()` from [lib/utils.ts](lib/utils.ts), and
  variant sets with `cva` — not string concatenation.
- Use the semantic tokens (`bg-card`, `text-muted-foreground`, `border-border`,
  `bg-primary`, `ring-ring`), not raw hexes or arbitrary values like
  `bg-[#0f131a]`. The tokens already track this app's theme switcher.

## 3. Custom motion and keyframes live in `app/globals.css` — only there

- `@keyframes` is **only** ever declared in [app/globals.css](app/globals.css).
  Never in a component, never in a `<style>` tag, never inline.
- Try `tw-animate-css` first (already installed): `animate-in`, `fade-in`,
  `slide-in-from-bottom-4`, `zoom-in-95`, `duration-200`. Most entrance and exit
  motion needs no custom CSS at all.
- Only when that can't express it, add to `globals.css`: the `@keyframes` block
  plus a matching `@theme { --animate-<name>: … }` entry, so the component still
  applies it as a utility class (`animate-<name>`) and never as raw CSS.
- `framer-motion` is a dependency and stays allowed for gesture, layout, and
  spring animation that CSS genuinely cannot do. Its `animate`/`transition`
  props are motion config, not styling — everything visual on that element is
  still Tailwind classes.

## Project specifics that change the usual advice

- **Tailwind v4, no `tailwind.config.js`.** Theme extension happens in
  `@theme` inside `globals.css`. Don't create a config file.
- **Tokens are `--ui-*` prefixed.** `app/page.tsx` already owns `--accent` and
  friends; `@theme inline` maps `--ui-*` onto the normal utility names. Add new
  tokens as `--ui-<name>` in `:root` *and* the `html[data-theme="light"]` block,
  then map them in `@theme inline`.
- **Utilities are imported unlayered on purpose.** The header comment in
  `globals.css` explains why. Don't "fix" those four `@import` lines into a
  single `@import "tailwindcss"` until `page.tsx`'s `<style>` block is gone.
- **`app/page.tsx` is legacy.** It is ~3.6k lines of inline styles, a `<style>`
  block, and five `@keyframes`. It is grandfathered, not a precedent. When you
  touch a region of it, migrate that region to shadcn + utilities and move any
  keyframes it used into `globals.css`. Do not extend the inline-style pattern.
