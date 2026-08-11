-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — add a wall-clock time of day to transactions
-- Run this in the Supabase SQL Editor, or `supabase db push` with the CLI.
--
-- spent_at_time is nullable: existing rows never captured a time, and the
-- picker in the UI is optional, so there is nothing to backfill it with.
-- It is a plain TIME (no timezone) for the same reason spent_on is a DATE,
-- not a timestamptz — see lib/calendar-day.ts. It's the wall-clock time the
-- user typed, not an instant, so there is no timezone to attach.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.transactions
  add column if not exists spent_at_time time;
