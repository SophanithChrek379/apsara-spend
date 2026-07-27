import { NextResponse } from "next/server";
import { requireUser, route } from "@/lib/api-helpers";
import { fetchLedger } from "@/lib/repository";
import { SCHEMA_VERSION } from "@/lib/constants";

/**
 * GET /api/ledger
 *
 * One-shot bootstrap: everything the app needs for first paint in a single
 * round trip, shaped exactly like the AppData the client already keeps in
 * localStorage. Avoids a transactions + budgets request waterfall on open.
 */
export const GET = route(async () => {
  const { supabase } = await requireUser();
  const { transactions, monthlyBalances } = await fetchLedger(supabase);

  return NextResponse.json({
    schema_version: SCHEMA_VERSION,
    transactions,
    monthlyBalances,
  });
});
