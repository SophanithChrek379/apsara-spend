-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — import January 2026
--
-- Source : expenses.csv  (55 rows · $584.20)
--          extracted from 55 ABA Bank receipt screenshots in
--          ~/Desktop/Jan 2026 - Expense/
-- Content: 55 transactions · $584.20 · nothing else is touched
--
-- The ledger currently starts at 2026-02 (see import-feb-mar-2026.sql). This
-- adds January in front of it, so the app shows a continuous Jan → Jul 2026.
--
-- DECISIONS BAKED INTO THIS SCRIPT
--   • CATEGORIES: you asked for none. The schema does not allow that —
--     transactions.category is `not null` with
--       check (category in ('food','transpo','bills','social','shop','misc'))
--     so a row cannot be stored without one. Every row goes in as 'misc'
--     rather than have me guess. Re-categorise in the app afterwards, or see
--     the note at the bottom for a one-liner per merchant.
--   • note = the payee exactly as the receipt printed it. The five receipts
--     that were charged in riel carry the original in the note, matching the
--     existing "(19400R)" convention in your Feb/Mar rows:
--       Huot Bona (14000R) · CHOK SOCHEAT (6000R) · អិន សុផល (6000R)
--       Mak Socheat (5000R) · Phuong Narin (5000R)
--     amount_usd is always the USD figure ABA actually debited.
--   • All 55 debits are included, the 15 person-to-person transfers among
--     them ($211.88 to ROS SOPHEAP on Jan 19 is the largest single row).
--     Delete them after import if this month should be spending only.
--   • The receipts' trx ids, APVs, reference numbers and account numbers have
--     no column in this schema and are not imported. expenses.json in the
--     source folder keeps them if you ever need to reconcile.
--   • spent_on takes the receipt's local (Asia/Phnom_Penh) calendar day. The
--     clock time is dropped — spent_on is a date by design.
--
-- Run the steps below IN ORDER in the Supabase SQL Editor.
--   STEP 0  see what is in Jan 2026 right now  (expected: no rows)
--   STEP 1  import — safe to re-run, it replaces that month
--   STEP 2  verify monthly totals
--   STEP 3  verify per-category totals
--
-- STEP 1 is one transaction with assertions at the end. If the count or the
-- total does not match the CSV it raises and the whole block rolls back.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 0 — what is currently stored for January 2026?
-- ═══════════════════════════════════════════════════════════════════════════
-- Same user id as the Feb/Mar import. Expected: zero rows (your ledger starts
-- 2026-02-01). If rows come back, STEP 1 replaces them — read them first and
-- make sure that is what you want.

select to_char(t.spent_on, 'YYYY-MM') as month,
       count(*)                       as entries,
       sum(t.amount_usd)              as spent,
       min(t.spent_on)                as first_day,
       max(t.spent_on)                as last_day
from public.transactions t
where t.user_id  = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  and t.spent_on >= date '2026-01-01'
  and t.spent_on <  date '2026-02-01'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — import the 55 rows
-- ═══════════════════════════════════════════════════════════════════════════
-- Run the whole block as one statement (`do $$` through `$$;`). It deletes
-- anything already sitting in Jan 2026 for this user and inserts the CSV, so
-- re-running it is safe and never duplicates. February onwards is untouched.

do $$
declare
  v_user  uuid := 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';  -- real device / mobile browser
  v_from  date := '2026-01-01';
  v_to    date := '2026-02-01';   -- exclusive
  v_old   bigint;
  v_new   bigint;
  v_total numeric;
begin
  if not exists (select 1 from auth.users where id = v_user) then
    raise exception 'No such user: %', v_user;
  end if;

  select count(*) into v_old
  from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to;

  delete from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to;

  raise notice 'cleared % existing row(s) in Jan 2026', v_old;

  insert into public.transactions (user_id, spent_on, category, note, amount_usd)
  select v_user, v.spent_on, v.category, v.note, v.amount_usd
  from (values
    ('2026-01-02'::date, 'misc', 'CALTEX APSARA 03', 3.90),
    ('2026-01-02'::date, 'misc', 'PHARMACIE P TP', 17.00),
    ('2026-01-06'::date, 'misc', 'PANN VOLEAK', 5.26),
    ('2026-01-06'::date, 'misc', 'Lucky Express Polaris F B', 6.80),
    ('2026-01-08'::date, 'misc', 'SOK SOCHEATA', 3.66),
    ('2026-01-09'::date, 'misc', 'BO SOKHOEURN', 11.00),
    ('2026-01-09'::date, 'misc', 'SAN RYNA', 66.00),
    ('2026-01-10'::date, 'misc', 'IT CHHAIYA', 2.00),
    ('2026-01-13'::date, 'misc', 'CALTEX APSARA 03', 3.69),
    ('2026-01-14'::date, 'misc', 'HEANG ROTHA', 1.00),
    ('2026-01-15'::date, 'misc', 'LUNA HEAD QUARTER', 1.75),
    ('2026-01-15'::date, 'misc', 'BO SOKHOEURN', 30.00),
    ('2026-01-16'::date, 'misc', 'CALTEX APSARA 01', 3.15),
    ('2026-01-16'::date, 'misc', 'LUNA HEAD QUARTER', 1.75),
    ('2026-01-17'::date, 'misc', 'SENG YOUHONG by S.TRY', 5.50),
    ('2026-01-17'::date, 'misc', 'CYCLO KK by M.K', 1.88),
    ('2026-01-17'::date, 'misc', 'LUCKY EXPRESS Phsar Kokir', 3.83),
    ('2026-01-18'::date, 'misc', 'Metfone Internet WiFi', 18.00),
    ('2026-01-19'::date, 'misc', 'HEANROTHA by R.HEANG', 0.50),
    ('2026-01-19'::date, 'misc', 'ROS SOPHEAP', 211.88),
    ('2026-01-19'::date, 'misc', 'CHHOR BUNNY', 2.99),
    ('2026-01-21'::date, 'misc', 'CALTEX PREKENG THMEY 02', 3.99),
    ('2026-01-21'::date, 'misc', 'LUNA HEAD QUARTER', 3.50),
    ('2026-01-21'::date, 'misc', 'THACH BINH', 2.74),
    ('2026-01-22'::date, 'misc', 'SOK ENGLY 1', 1.25),
    ('2026-01-23'::date, 'misc', 'KONG PAOPONNARITH', 4.98),
    ('2026-01-23'::date, 'misc', 'LUCKY EXPRESS Phsar Kokir', 11.27),
    ('2026-01-23'::date, 'misc', 'អិន សុផល (6000R)', 1.50),
    ('2026-01-23'::date, 'misc', 'PHEAK MONIROTH', 1.25),
    ('2026-01-23'::date, 'misc', 'CHOK SOCHEAT (6000R)', 1.50),
    ('2026-01-24'::date, 'misc', 'Mak Socheat (5000R)', 1.25),
    ('2026-01-25'::date, 'misc', 'TELA KHMER TSP VM 1', 1.38),
    ('2026-01-25'::date, 'misc', 'MikesAngkta by B.MEAN', 1.00),
    ('2026-01-25'::date, 'misc', 'SOMANG ROTHNAK AND TECH CHAN MONY', 25.00),
    ('2026-01-26'::date, 'misc', 'CALTEX APSARA 03', 3.67),
    ('2026-01-26'::date, 'misc', 'Phuong Narin (5000R)', 1.25),
    ('2026-01-26'::date, 'misc', 'LUNA HEAD QUARTER', 3.50),
    ('2026-01-27'::date, 'misc', 'KEM KANNITHA', 1.25),
    ('2026-01-27'::date, 'misc', 'ROS SOPHEAP', 2.50),
    ('2026-01-27'::date, 'misc', 'MEOWPAD by V.KHAN', 8.00),
    ('2026-01-27'::date, 'misc', 'Huot Bona (14000R)', 3.49),
    ('2026-01-28'::date, 'misc', 'SOK ENGLY 1', 1.25),
    ('2026-01-28'::date, 'misc', 'HEANROTHA by R.HEANG', 0.50),
    ('2026-01-28'::date, 'misc', 'Luna Head Office', 0.62),
    ('2026-01-28'::date, 'misc', 'MIN MAKARA', 10.00),
    ('2026-01-29'::date, 'misc', 'PHUONG NARIN', 1.25),
    ('2026-01-29'::date, 'misc', 'ROS SOPHEAP', 1.25),
    ('2026-01-29'::date, 'misc', 'SENG DIRATTANA', 26.00),
    ('2026-01-29'::date, 'misc', 'SOK SOCHEATA', 3.80),
    ('2026-01-30'::date, 'misc', 'HEANG ROTHA', 1.00),
    ('2026-01-30'::date, 'misc', 'CMRT Eden', 17.72),
    ('2026-01-30'::date, 'misc', 'TOUN VICHAN', 24.00),
    ('2026-01-31'::date, 'misc', 'Smart Axiata Co Ltd', 1.50),
    ('2026-01-31'::date, 'misc', 'Smart Axiata Co Ltd', 4.50),
    ('2026-01-31'::date, 'misc', 'CHHIM PENHBO', 5.00)
  ) as v (spent_on, category, note, amount_usd);

  -- ── assertions: roll everything back unless this matches the CSV ────────
  select count(*), coalesce(sum(amount_usd), 0) into v_new, v_total
  from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to;

  if v_new <> 55 then
    raise exception 'expected 55 rows in Jan 2026, found %', v_new;
  end if;

  if v_total <> 584.20 then
    raise exception 'expected total 584.20, found %', v_total;
  end if;

  raise notice 'imported % rows totalling %', v_new, v_total;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — monthly budget for January
-- ═══════════════════════════════════════════════════════════════════════════
-- The receipts carry no budget, so none is created; the app will show January
-- with no budget set. Fill in the number and run this if you want one.
--
-- insert into public.monthly_budgets (user_id, month, amount_usd)
-- values ('a60d2ff5-97b0-4c67-9f9b-b6cffed079f9', '2026-01', 000.00)
-- on conflict (user_id, month) do update set amount_usd = excluded.amount_usd;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — verify: monthly totals. Expected first row:
--
--   month     entries    spent
--   2026-01        55   584.20
-- ═══════════════════════════════════════════════════════════════════════════
with m as (
  select to_char(spent_on, 'YYYY-MM') as month,
         count(*)                     as entries,
         sum(amount_usd)              as spent
  from public.transactions
  where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  group by 1
)
select m.month,
       m.entries,
       m.spent,
       b.amount_usd           as budget,
       b.amount_usd - m.spent as remaining
from m
left join public.monthly_budgets b
       on b.month = m.month
      and b.user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
order by m.month;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3 — verify: per-category totals. Expected for the new month —
-- everything sits in misc by design, see DECISIONS at the top:
--
--   month       food  transpo    bills   social     shop     misc    total
--   2026-01        —        —        —        —        —   584.20   584.20
-- ═══════════════════════════════════════════════════════════════════════════
select to_char(spent_on, 'YYYY-MM')                    as month,
       sum(amount_usd) filter (where category = 'food')    as food,
       sum(amount_usd) filter (where category = 'transpo') as transpo,
       sum(amount_usd) filter (where category = 'bills')   as bills,
       sum(amount_usd) filter (where category = 'social')  as social,
       sum(amount_usd) filter (where category = 'shop')    as shop,
       sum(amount_usd) filter (where category = 'misc')    as misc,
       sum(amount_usd)                                     as total,
       count(*)                                            as entries
from public.transactions
where user_id  = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  and spent_on >= date '2026-01-01'
  and spent_on <  date '2026-02-01'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — re-categorise by merchant, once you have decided
-- ═══════════════════════════════════════════════════════════════════════════
-- Recurring payees in this month, if you want to move them off misc in bulk.
-- Uncomment the lines you agree with; each is scoped to January only.
--
-- update public.transactions set category = 'transpo'
--  where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
--    and spent_on >= date '2026-01-01' and spent_on < date '2026-02-01'
--    and (note like 'CALTEX%' or note like 'TELA KHMER%');            -- 6 rows, 19.78
--
-- update public.transactions set category = 'bills'
--  where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
--    and spent_on >= date '2026-01-01' and spent_on < date '2026-02-01'
--    and (note like 'Smart Axiata%' or note like 'Metfone%'
--         or note like 'PHARMACIE%');                                  -- 4 rows, 41.00
--
-- update public.transactions set category = 'food'
--  where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
--    and spent_on >= date '2026-01-01' and spent_on < date '2026-02-01'
--    and (note like 'LUNA HEAD%' or note like 'Luna Head%');           -- 5 rows, 11.12


-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER THE IMPORT
-- ═══════════════════════════════════════════════════════════════════════════
-- These rows are new on the server and have no counterpart in the browser
-- cache, so no id collision like the 2026-07-27 re-import had. Just pull to
-- refresh on the dashboard (or reload) and January 2026 appears in the month
-- picker. No need to clear site data.
