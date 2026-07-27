import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

let warnedMissingEnv = false;

export const createClient = async (request: NextRequest) => {
  // Create an unmodified response
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // Fail open. This runs on EVERY matched request, so throwing here takes the
  // entire site down with a 500 — including the homepage, which needs no auth
  // at all. A missing env var should cost you session refresh, not the app.
  if (!supabaseUrl || !supabaseKey) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.error(
        "[proxy] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set — " +
        "skipping session refresh. The app will run in cache-only mode.",
      );
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    },
  );

  // IMPORTANT: this call is what actually refreshes an expired auth token.
  // getUser() triggers the refresh, which fires setAll() above, which writes
  // the rotated cookies onto supabaseResponse. Without it the middleware is
  // a no-op and sessions silently expire. Do not remove, and do not run any
  // logic between createServerClient and here.
  await supabase.auth.getUser();

  return supabaseResponse
};
