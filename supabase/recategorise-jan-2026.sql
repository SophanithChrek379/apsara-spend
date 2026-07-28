-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — re-categorise January 2026
--
-- Companion to import-jan-2026.sql, which landed all 55 rows as 'misc'
-- because transactions.category is `not null` and CHECK-constrained.
-- The rows are ALREADY IN THE TABLE. This script only ever runs UPDATE —
-- it never deletes, never inserts, and never touches amount_usd, note or
-- spent_on. Any other month is out of range and untouched.
--
-- Safe to re-run: the update is idempotent (setting the same value again is a
-- no-op), and it is scoped to Jan 2026 for one user.
--
-- ── HOW EACH ROW WAS DECIDED ──────────────────────────────────────────────
-- Following the conventions in import-feb-mar-2026.sql:
--   food     eat & drink, incl. mineral water
--   transpo  motor gasoline only
--   bills    phone/SIM/WiFi, medicine & treatment, support mom, motor
--            oil & wash, haircut, parties, events
--   shop     goods
--   misc     everything not established
--
-- Lines are marked so you can see how much to trust each one. READ THE 36
-- MARKED LINES BEFORE RUNNING — edit any you disagree with, they are one
-- word each.
--
--   (no mark)      19 rows — merchant is named on the receipt, no judgement
--                  needed: CALTEX + TELA → transpo, Smart Axiata / Metfone /
--                  PHARMACIE → bills, LUNA / LUCKY / CMRT Eden → food.
--
--   -- ? inferred  20 rows — small QR payments to a named vendor. At $0.50–
--                  $5.50 street/market food & drink is the only plausible
--                  read, and it matches your Feb/Mar pattern of many sub-$5
--                  food rows. But the receipt does not actually say so.
--                  MEOWPAD by V.KHAN ($8.00) → shop is the weakest guess
--                  here; the name reads like a pet/goods shop, nothing more.
--
--   -- ? transfer  15 rows — person-to-person transfers. A bank receipt
--                  cannot tell you what a transfer was for; only you know.
--                  Left as 'misc' deliberately. Includes the $211.88 to
--                  ROS SOPHEAP on Jan 19 and $25.00 to SOMANG ROTHNAK AND
--                  TECH CHAN MONY (reads like a wedding — 'bills' would fit
--                  your "relative's event" convention, but I am not guessing).
--
--   -- ? unknown   1 row — SAN RYNA, $66.00, Jan 09. A person-named merchant
--                  payment with nothing else to go on. Left as 'misc'.
--
-- ── WHAT THIS PRODUCES ────────────────────────────────────────────────────
--   food     28 rows    91.07
--   transpo   6 rows    19.78
--   bills     4 rows    41.00
--   social    0 rows        —
--   shop      1 rows     8.00
--   misc     16 rows   424.35   ← the 15 transfers + SAN RYNA
--   total    55 rows   584.20
--
-- If you set the 16 misc rows yourself, edit them below and the assertions
-- still hold — they check the row count and the untouched grand total, not
-- the split.
--
-- Run STEP 1, then STEP 2 to eyeball the result.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 0 — confirm the 55 rows are there and all still misc
-- ═══════════════════════════════════════════════════════════════════════════
-- Expected: one row — misc | 55 | 584.20
-- If you have already re-categorised some by hand, you will see several rows.
-- That is fine; STEP 1 overwrites category for all 55 regardless.

select category, count(*) as entries, sum(amount_usd) as spent
from public.transactions
where user_id  = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  and spent_on >= date '2026-01-01'
  and spent_on <  date '2026-02-01'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — set the category on each of the 55 rows
-- ═══════════════════════════════════════════════════════════════════════════
-- Run the whole block as one statement (`do $$` through `$$;`). Each row is
-- matched on (spent_on, note, amount_usd) — verified unique across the month,
-- so no line can hit the wrong transaction. If a line matches nothing (you
-- edited a note, say) the assertion at the end raises and everything rolls
-- back with nothing changed.

do $$
declare
  v_user  uuid := 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';  -- real device / mobile browser
  v_from  date := '2026-01-01';
  v_to    date := '2026-02-01';   -- exclusive
  v_hit   bigint;
  v_all   bigint;
  v_total numeric;
  v_misc  bigint;
begin
  if not exists (select 1 from auth.users where id = v_user) then
    raise exception 'No such user: %', v_user;
  end if;

  with m (spent_on, note, amount_usd, category) as (values
    ('2026-01-02'::date, 'CALTEX APSARA 03',                     3.90, 'transpo'),
    ('2026-01-02'::date, 'PHARMACIE P TP',                      17.00, 'bills'  ),
    ('2026-01-06'::date, 'PANN VOLEAK',                          5.26, 'misc'   ),   -- ? transfer
    ('2026-01-06'::date, 'Lucky Express Polaris F B',            6.80, 'food'   ),
    ('2026-01-08'::date, 'SOK SOCHEATA',                         3.66, 'misc'   ),   -- ? transfer
    ('2026-01-09'::date, 'BO SOKHOEURN',                        11.00, 'misc'   ),   -- ? transfer
    ('2026-01-09'::date, 'SAN RYNA',                            66.00, 'misc'   ),   -- ? unknown
    ('2026-01-10'::date, 'IT CHHAIYA',                           2.00, 'misc'   ),   -- ? transfer
    ('2026-01-13'::date, 'CALTEX APSARA 03',                     3.69, 'transpo'),
    ('2026-01-14'::date, 'HEANG ROTHA',                          1.00, 'misc'   ),   -- ? transfer
    ('2026-01-15'::date, 'LUNA HEAD QUARTER',                    1.75, 'food'   ),
    ('2026-01-15'::date, 'BO SOKHOEURN',                        30.00, 'misc'   ),   -- ? transfer
    ('2026-01-16'::date, 'CALTEX APSARA 01',                     3.15, 'transpo'),
    ('2026-01-16'::date, 'LUNA HEAD QUARTER',                    1.75, 'food'   ),
    ('2026-01-17'::date, 'SENG YOUHONG by S.TRY',                5.50, 'food'   ),   -- ? inferred
    ('2026-01-17'::date, 'CYCLO KK by M.K',                      1.88, 'food'   ),   -- ? inferred
    ('2026-01-17'::date, 'LUCKY EXPRESS Phsar Kokir',            3.83, 'food'   ),
    ('2026-01-18'::date, 'Metfone Internet WiFi',               18.00, 'bills'  ),
    ('2026-01-19'::date, 'HEANROTHA by R.HEANG',                 0.50, 'food'   ),   -- ? inferred
    ('2026-01-19'::date, 'ROS SOPHEAP',                        211.88, 'misc'   ),   -- ? transfer
    ('2026-01-19'::date, 'CHHOR BUNNY',                          2.99, 'food'   ),   -- ? inferred
    ('2026-01-21'::date, 'CALTEX PREKENG THMEY 02',              3.99, 'transpo'),
    ('2026-01-21'::date, 'LUNA HEAD QUARTER',                    3.50, 'food'   ),
    ('2026-01-21'::date, 'THACH BINH',                           2.74, 'food'   ),   -- ? inferred
    ('2026-01-22'::date, 'SOK ENGLY 1',                          1.25, 'food'   ),   -- ? inferred
    ('2026-01-23'::date, 'KONG PAOPONNARITH',                    4.98, 'food'   ),   -- ? inferred
    ('2026-01-23'::date, 'LUCKY EXPRESS Phsar Kokir',           11.27, 'food'   ),
    ('2026-01-23'::date, 'អិន សុផល (6000R)',                     1.50, 'food'   ),   -- ? inferred
    ('2026-01-23'::date, 'PHEAK MONIROTH',                       1.25, 'food'   ),   -- ? inferred
    ('2026-01-23'::date, 'CHOK SOCHEAT (6000R)',                 1.50, 'food'   ),   -- ? inferred
    ('2026-01-24'::date, 'Mak Socheat (5000R)',                  1.25, 'food'   ),   -- ? inferred
    ('2026-01-25'::date, 'TELA KHMER TSP VM 1',                  1.38, 'transpo'),
    ('2026-01-25'::date, 'MikesAngkta by B.MEAN',                1.00, 'food'   ),   -- ? inferred
    ('2026-01-25'::date, 'SOMANG ROTHNAK AND TECH CHAN MONY',   25.00, 'misc'   ),   -- ? transfer
    ('2026-01-26'::date, 'CALTEX APSARA 03',                     3.67, 'transpo'),
    ('2026-01-26'::date, 'Phuong Narin (5000R)',                 1.25, 'food'   ),   -- ? inferred
    ('2026-01-26'::date, 'LUNA HEAD QUARTER',                    3.50, 'food'   ),
    ('2026-01-27'::date, 'KEM KANNITHA',                         1.25, 'food'   ),   -- ? inferred
    ('2026-01-27'::date, 'ROS SOPHEAP',                          2.50, 'misc'   ),   -- ? transfer
    ('2026-01-27'::date, 'MEOWPAD by V.KHAN',                    8.00, 'shop'   ),   -- ? inferred
    ('2026-01-27'::date, 'Huot Bona (14000R)',                   3.49, 'food'   ),   -- ? inferred
    ('2026-01-28'::date, 'SOK ENGLY 1',                          1.25, 'food'   ),   -- ? inferred
    ('2026-01-28'::date, 'HEANROTHA by R.HEANG',                 0.50, 'food'   ),   -- ? inferred
    ('2026-01-28'::date, 'Luna Head Office',                     0.62, 'food'   ),
    ('2026-01-28'::date, 'MIN MAKARA',                          10.00, 'misc'   ),   -- ? transfer
    ('2026-01-29'::date, 'PHUONG NARIN',                         1.25, 'food'   ),   -- ? inferred
    ('2026-01-29'::date, 'ROS SOPHEAP',                          1.25, 'misc'   ),   -- ? transfer
    ('2026-01-29'::date, 'SENG DIRATTANA',                      26.00, 'misc'   ),   -- ? transfer
    ('2026-01-29'::date, 'SOK SOCHEATA',                         3.80, 'misc'   ),   -- ? transfer
    ('2026-01-30'::date, 'HEANG ROTHA',                          1.00, 'misc'   ),   -- ? transfer
    ('2026-01-30'::date, 'CMRT Eden',                           17.72, 'food'   ),
    ('2026-01-30'::date, 'TOUN VICHAN',                         24.00, 'misc'   ),   -- ? transfer
    ('2026-01-31'::date, 'Smart Axiata Co Ltd',                  1.50, 'bills'  ),
    ('2026-01-31'::date, 'Smart Axiata Co Ltd',                  4.50, 'bills'  ),
    ('2026-01-31'::date, 'CHHIM PENHBO',                         5.00, 'food'   )   -- ? inferred
  )
  update public.transactions t
     set category = m.category
    from m
   where t.user_id    = v_user
     and t.spent_on  >= v_from
     and t.spent_on   < v_to
     and t.spent_on   = m.spent_on
     and t.note       = m.note
     and t.amount_usd = m.amount_usd;

  get diagnostics v_hit = row_count;

  -- ── assertions: roll back unless every row was matched exactly once ─────
  if v_hit <> 55 then
    raise exception 'expected to update 55 rows, updated % — no line may be '
                    'left unmatched; nothing has been changed', v_hit;
  end if;

  select count(*), coalesce(sum(amount_usd), 0) into v_all, v_total
  from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to;

  if v_all <> 55 or v_total <> 584.20 then
    raise exception 'Jan 2026 should still be 55 rows / 584.20 after a '
                    'category-only update, found % rows / %', v_all, v_total;
  end if;

  select count(*) into v_misc
  from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to
    and category = 'misc';

  raise notice 'recategorised % rows; % still misc (the transfers + SAN RYNA)',
               v_hit, v_misc;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — verify. Expected:
--
--   month       food  transpo    bills   social     shop     misc    total
--   2026-01    91.07    19.78    41.00        —     8.00   424.35   584.20
-- ═══════════════════════════════════════════════════════════════════════════
select to_char(spent_on, 'YYYY-MM')                        as month,
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
-- STEP 3 — the 16 rows still sitting in misc, so you can finish them off
-- ═══════════════════════════════════════════════════════════════════════════
select spent_on, note, amount_usd
from public.transactions
where user_id  = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  and spent_on >= date '2026-01-01'
  and spent_on <  date '2026-02-01'
  and category = 'misc'
order by spent_on, amount_usd desc;

-- Set one of them like this (category must be one of
-- food / transpo / bills / social / shop / misc):
--
-- update public.transactions set category = 'bills'
--  where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
--    and spent_on = date '2026-01-25'
--    and note = 'SOMANG ROTHNAK AND TECH CHAN MONY';


-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER THE UPDATE
-- ═══════════════════════════════════════════════════════════════════════════
-- category is the only column that moved, so the browser cache still agrees on
-- ids, amounts and dates. Pull to refresh on the dashboard (or reload) and the
-- January donut/breakdown redraws. No need to clear site data.
