import type { NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/middleware";

// Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`.
// This runs on every matched request and refreshes the Supabase auth session.
export default async function proxy(request: NextRequest) {
  return await createClient(request);
}

export const config = {
  matcher: [
    /*
     * Run on every request except Next.js internals, the PWA shell files and
     * image assets. Extend the extension list if you add more static types.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icon-192.png|icon-512.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
