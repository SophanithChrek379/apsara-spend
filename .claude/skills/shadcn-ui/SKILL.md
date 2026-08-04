---
name: shadcn-ui
description: Build, restyle, or migrate any UI in this app — components, screens, dialogs, forms, buttons, lists, animations. Enforces shadcn/ui as the component source, Tailwind utilities as the only styling mechanism, and app/globals.css as the only home for custom keyframes. Use whenever adding or changing anything that renders, or when migrating a region of app/page.tsx off inline styles.
---

# Building UI in apsara-spend

The hard rules are in [ui-styling.md](../../rules/ui-styling.md) and are always
loaded. This skill is the how-to.

## Before writing any component

1. **Name the shadcn component that fits.** Match on behaviour, not appearance.

   | You need | Use |
   |---|---|
   | any clickable action | `button` |
   | modal, confirm | `dialog` / `alert-dialog` |
   | bottom or side panel | `sheet` |
   | picker over a short list | `select` |
   | picker over a long/searchable list | `command` inside `popover` |
   | inline menu off a trigger | `dropdown-menu` |
   | switch between views | `tabs` |
   | mutually exclusive filters | `toggle-group` |
   | boolean setting | `switch` |
   | text entry | `input` / `textarea` + `label` |
   | grouped fields with errors | `form` (+ `input`, `label`) |
   | container surface | `card` |
   | status pill | `badge` |
   | loading placeholder | `skeleton` |
   | transient feedback | `sonner` |
   | date entry | `calendar` inside `popover` |

2. **Check whether it exists yet.** `ls components/ui/` — this project is early,
   so most are not installed.

3. **Install, don't author:**
   ```bash
   npx shadcn@latest add dialog sheet select
   ```
   Generated files land in `components/ui/` and use `@/lib/utils`'s `cn()`.
   Review the diff; the CLI can touch `globals.css`.

4. **Only if nothing matches**, build it on Radix in `components/ui/<name>.tsx`,
   copying the conventions in [button.tsx](../../../components/ui/button.tsx):
   `cva` for variants, `forwardRef`, `cn(className)` last so callers can
   override, `data-slot` on each part.

## Composing screen-level components

App components go in `components/<feature>/`, never in `components/ui/`
(that directory is reserved for shadcn primitives so `shadcn add` upgrades stay
clean).

Import the primitive, style the composition with utilities:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export function SpendSummary({ total, over }: { total: string; over: boolean }) {
  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          This month
        </CardTitle>
        {over && <Badge variant="destructive">Over budget</Badge>}
      </CardHeader>
      <CardContent className="text-3xl font-semibold tabular-nums">
        {total}
      </CardContent>
    </Card>
  )
}
```

Note what is absent: no `style={{}}`, no hex colours, no `<style>` tag.

## Motion

Reach for these in order — stop at the first that works.

**1. `tw-animate-css` utilities** (installed, imported in `globals.css`):

```tsx
<div className="animate-in fade-in slide-in-from-bottom-4 duration-200">
```

**2. A custom animation registered in `app/globals.css`.** Two pieces — the
keyframes, and a `--animate-*` theme entry that turns it into a utility:

```css
@theme {
  --animate-budget-pulse: budgetPulse 1.6s ease-in-out infinite;
}

@keyframes budgetPulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
```

Then in the component: `className="animate-budget-pulse"`. The component never
sees CSS.

**3. `framer-motion`** for drag, layout transitions, springs, and shared-element
motion. Motion props only; visuals stay on `className`:

```tsx
<motion.div layout transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="rounded-xl bg-card p-4">
```

## Tokens

Use semantic utilities: `bg-background`, `bg-card`, `bg-muted`, `bg-primary`,
`text-foreground`, `text-muted-foreground`, `border-border`, `ring-ring`,
`bg-destructive`, and `text-chart-1` … `text-chart-5` for categories.

Adding a token means three edits in `app/globals.css`:

1. `:root { --ui-<name>: …; }` — dark values (dark is the default here)
2. `html[data-theme="light"] { --ui-<name>: …; }` — light values
3. `@theme inline { --color-<name>: var(--ui-<name>); }` — makes `bg-<name>` real

Keep the `--ui-` prefix. `page.tsx` owns the unprefixed names, and collisions
there repaint every hover state.

## Migrating a slice of `app/page.tsx`

It is ~3.6k lines of inline styles with a `<style>` block at line ~2335. Don't
attempt it wholesale. When a task touches one region:

1. Lift that region into `components/<feature>/<Name>.tsx`.
2. Swap hand-rolled elements for the matching shadcn component.
3. Convert its inline styles to utilities, mapping raw hexes to the token that
   already represents them (see the `--ui-*` fallbacks in `globals.css`).
4. Move any `@keyframes` it depended on out of the `<style>` block and into
   `globals.css` as a `--animate-*` entry.
5. Leave the rest of the `<style>` block alone, and leave the four unlayered
   `@import` lines alone — they can only be collapsed once that block is empty.

## Self-check before finishing

- [ ] No `style={{ … }}` except a single runtime-computed property
- [ ] No `<style>` tag, CSS module, or component-adjacent `.css` file
- [ ] No `@keyframes` outside `app/globals.css`
- [ ] No arbitrary colour values (`bg-[#…]`) where a token exists
- [ ] Every button/dialog/select/etc. is the shadcn component, not a raw element
- [ ] Conditional classes go through `cn()`
- [ ] New primitives live in `components/ui/`, features in `components/<feature>/`
