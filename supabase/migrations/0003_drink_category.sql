-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — add the "drink" category
-- Run this in the Supabase SQL Editor, or `supabase db push` with the CLI.
--
-- The category list is a CHECK constraint rather than a Postgres enum, so
-- widening it is a drop and re-add of the constraint — no type surgery, no
-- table rewrite beyond the revalidation scan.
--
-- RUN THIS BEFORE DEPLOYING THE CLIENT THAT OFFERS THE CATEGORY. The client
-- lets you pick Drink the moment it ships; until the constraint knows the
-- value, the insert is rejected and the entry sits unsynced on the device.
-- Widening first is safe on its own: an older client simply never sends it.
--
-- Nothing to backfill. Existing rows keep whatever category they already have;
-- re-filing a past expense as Drink is an ordinary edit in the app.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.transactions
  drop constraint if exists transactions_category_valid;

alter table public.transactions
  add constraint transactions_category_valid
  check (category in ('food','drink','transpo','bills','social','shop','misc'));
