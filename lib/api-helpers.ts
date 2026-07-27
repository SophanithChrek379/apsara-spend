import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient, isSupabaseConfigured } from "@/utils/supabase/server";
import { ValidationError } from "@/lib/validation";

export class AuthError extends Error {}
/** Env vars absent — a deployment problem, not a client problem. */
export class ConfigError extends Error {}

/**
 * Resolves the caller from the Supabase auth cookie. Anonymous users are real
 * users with a real uid, so nothing here special-cases them — RLS does the
 * scoping and this only decides 401 vs proceed.
 *
 * getUser() is used rather than getSession() because it verifies the JWT with
 * the auth server instead of trusting a cookie the client could have forged.
 */
export const requireUser = async (): Promise<{
  supabase: SupabaseClient;
  user: User;
}> => {
  if (!isSupabaseConfigured()) {
    throw new ConfigError(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set",
    );
  }
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new AuthError("Not authenticated");
  }
  return { supabase: supabase as SupabaseClient, user: data.user };
};

/**
 * Wraps a route handler so thrown errors become correct status codes instead of
 * an opaque 500. Unexpected errors are logged server-side but never echoed to
 * the client, so Postgres messages can't leak schema details.
 */
export const route = <Ctx>(
  fn: (req: Request, ctx: Ctx) => Promise<NextResponse>,
) => async (req: Request, ctx: Ctx): Promise<NextResponse> => {
  try {
    return await fn(req, ctx);
  } catch (err) {
    if (err instanceof ConfigError) {
      // 503, not 500: the server is reachable but not configured. Logged in
      // full so the cause is obvious in the deployment logs.
      console.error("[api] misconfigured:", err.message);
      return NextResponse.json({ error: "Server not configured" }, { status: 503 });
    }
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[api]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
};

/** Reads and JSON-parses a request body, turning malformed JSON into a 400. */
export const readJson = async (req: Request): Promise<unknown> => {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
};
