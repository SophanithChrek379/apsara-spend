-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — repair transactions stored one day early
--
-- BACKGROUND
-- Until the calendar-day fix, the client serialised the picked day as *local*
-- midnight ("2026-07-27T00:00:00" → "2026-07-26T17:00:00.000Z" in UTC+7) and
-- the route handlers read that instant back with server-local components. Node
-- on Vercel runs in UTC, so `spent_on` was written one day behind: an expense
-- entered on 27 July landed on the 26th.
--
-- WHAT IS AFFECTED
-- Only rows the *app* wrote through /api/sync while the bug was live. The 295
-- rows from reimport-2026-07-27.sql were inserted as plain dates straight from
-- the CSV and are correct — do not shift them.
--
-- The two are distinguishable: the re-import inserted every row in one
-- statement, so its rows share a created_at and have never been updated. A row
-- the app has written or edited since is either newer than that batch or has
-- updated_at > created_at.
--
-- RUN STEP 1 AND READ IT. Only run STEP 2 if the listed rows are genuinely the
-- ones showing the wrong day in the app. STEP 2 is reversible (STEP 3).
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — inspect: which rows did the app touch after the re-import?
-- ═══════════════════════════════════════════════════════════════════════════
with v as (
  select 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'::uuid as v_user
),
import_batch as (
  -- The re-import's created_at: the timestamp shared by the largest insert.
  select created_at
  from public.transactions, v
  where user_id = v.v_user
  group by created_at
  order by count(*) desc
  limit 1
)
select t.id,
       t.spent_on                    as stored_day,
       t.spent_on + 1                as intended_day,
       t.category,
       t.note,
       t.amount_usd,
       t.created_at,
       t.updated_at
from public.transactions t, v, import_batch i
where t.user_id = v.v_user
  and (t.created_at > i.created_at or t.updated_at > t.created_at)
order by t.spent_on, t.created_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — repair: shift those rows forward one day
-- ═══════════════════════════════════════════════════════════════════════════
-- Wrapped so the count is reported before you commit. If it does not match what
-- STEP 1 listed, roll back instead.
do $$
declare
  v_user     uuid := 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';
  v_import   timestamptz;
  v_shifted  int;
begin
  select created_at into v_import
  from public.transactions
  where user_id = v_user
  group by created_at
  order by count(*) desc
  limit 1;

  if v_import is null then
    raise exception 'No transactions for %, nothing to repair', v_user;
  end if;

  update public.transactions
     set spent_on = spent_on + 1
   where user_id = v_user
     and (created_at > v_import or updated_at > created_at);

  get diagnostics v_shifted = row_count;
  raise notice 'Shifted % row(s) forward one day.', v_shifted;

  -- Safety rail: the bug shipped with the Postgres migration today, so a repair
  -- touching a large slice of the ledger means the criterion above matched the
  -- re-imported rows too. Refuse rather than corrupt 295 correct rows.
  if v_shifted > 50 then
    raise exception
      'Refusing: % rows matched, which is more than the app can have written since the re-import. Re-check STEP 1.',
      v_shifted;
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3 — undo, if STEP 2 shifted the wrong rows
-- ═══════════════════════════════════════════════════════════════════════════
-- Only valid immediately after STEP 2: it re-selects by the same criterion, and
-- STEP 2's own write bumped updated_at, so the set is unchanged.
--
--   update public.transactions
--      set spent_on = spent_on - 1
--    where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
--      and updated_at > created_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER THE REPAIR
-- ═══════════════════════════════════════════════════════════════════════════
-- The device is holding these rows in its localStorage cache with the old days.
-- Open the app and pull to refresh, or tap Sync now in Settings: the pull
-- reconciles against the server and adopts the corrected dates.
