# Apsara Spend 💰

Personal expense tracker built for daily use in Cambodia.

- **Stack:** Next.js 14 · TypeScript · Framer Motion · Lucide Icons
- **Currency:** USD (primary) + KHR (1 USD = 4,000 ៛ fixed)
- **Budget:** $300 warning · $350 hard ceiling
- **Storage:** localStorage (`apsara_spend_v2`)
- **Deployment:** Vercel

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Add to iPhone Home Screen

1. Open the Vercel URL in Safari
2. Tap the Share icon → **Add to Home Screen**
3. Use it like a native app — full-screen, no browser chrome

## Project Structure

```
app/
  layout.tsx   # Root layout + PWA meta
  page.tsx     # Main app (single page)
public/
  manifest.json
  icon-192.png
  icon-512.png
```
