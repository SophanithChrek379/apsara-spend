-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — import February & March 2026
--
-- Source : february_2025_expenses.csv  (76 rows · $419.95)
--          march_2026_expenses.csv     (82 rows · $299.51)
-- Content: 158 transactions · $719.46 · nothing else is touched
--
-- The ledger currently starts at 2026-04. This adds the two months in front of
-- it, so the app shows a continuous Feb → Jul 2026.
--
-- DECISIONS BAKED INTO THIS SCRIPT
--   • The February CSV is dated 2025 (01/Feb/2025 …). Confirmed as a typo —
--     every February row is inserted as 2026-02-xx.
--   • 24 Feb "Parking, 0.625" → 0.63. amount_usd is numeric(10,2); a third
--     decimal cannot be stored. This is the only value that changed.
--   • Categories follow the conventions already in your Apr–Jul rows:
--       food    eat & drink, incl. mineral water, KTV/pub outings
--       transpo motor gasoline only
--       bills   phone/SIM/WiFi, water payment, support mom, medicine &
--               treatment, motor oil & wash, haircut, parties, events, exam,
--               team treats  ("Monthly party with team" is bills in Apr–Jul)
--       shop    goods — clothes, body spray, mouse pad, mask, earphone, …
--       misc    parking
--     The `social` category stays unused, as in Apr–Jul.
--
-- Run the steps below IN ORDER in the Supabase SQL Editor.
--   STEP 0  see what is in Feb/Mar 2026 right now  (expected: no rows)
--   STEP 1  import — safe to re-run, it replaces those two months
--   STEP 2  verify monthly totals
--   STEP 3  verify per-category totals
--
-- STEP 1 is one transaction with assertions at the end. If the count or the
-- total does not match the CSVs it raises and the whole block rolls back.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 0 — what is currently stored for Feb and Mar 2026?
-- ═══════════════════════════════════════════════════════════════════════════
-- Same user id as the 2026-07-27 re-import. Expected: zero rows for both
-- months (your ledger starts 2026-04-01). If rows come back, STEP 1 replaces
-- them — read them first and make sure that is what you want.

select to_char(t.spent_on, 'YYYY-MM') as month,
       count(*)                       as entries,
       sum(t.amount_usd)              as spent,
       min(t.spent_on)                as first_day,
       max(t.spent_on)                as last_day
from public.transactions t
where t.user_id  = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
  and t.spent_on >= date '2026-02-01'
  and t.spent_on <  date '2026-04-01'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — import the 158 rows
-- ═══════════════════════════════════════════════════════════════════════════
-- Run the whole block as one statement (`do $$` through `$$;`). It deletes
-- anything already sitting in Feb/Mar 2026 for this user and inserts the CSVs,
-- so re-running it is safe and never duplicates. April onwards is untouched.

do $$
declare
  v_user  uuid := 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';  -- real device / mobile browser
  v_from  date := '2026-02-01';
  v_to    date := '2026-04-01';   -- exclusive
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

  raise notice 'cleared % existing row(s) in Feb–Mar 2026', v_old;

  insert into public.transactions (user_id, spent_on, category, note, amount_usd)
  select v_user, v.spent_on, v.category, v.note, v.amount_usd
  from (values
    ('2026-02-01'::date, 'bills', 'Card phone number', 6.00),
    ('2026-02-06'::date, 'food', 'Cafe with babe❤️', 2.00),
    ('2026-02-06'::date, 'food', 'Dinner with babe❤️', 11.98),
    ('2026-02-06'::date, 'shop', 'Mouse pad for babe❤️', 16.00),
    ('2026-02-07'::date, 'food', 'Dinner with family', 8.00),
    ('2026-02-07'::date, 'transpo', 'Motor gasoline', 4.12),
    ('2026-02-08'::date, 'food', 'Breakfast', 1.25),
    ('2026-02-08'::date, 'food', 'Snack', 1.00),
    ('2026-02-09'::date, 'food', 'Breakfast', 0.75),
    ('2026-02-09'::date, 'food', 'Cafe for my babe❤️', 4.38),
    ('2026-02-09'::date, 'food', 'Drink', 1.00),
    ('2026-02-09'::date, 'food', 'Food Prepared a week', 8.25),
    ('2026-02-10'::date, 'food', 'Snack', 0.75),
    ('2026-02-10'::date, 'food', 'Cafe', 2.00),
    ('2026-02-10'::date, 'food', 'Dinner', 2.43),
    ('2026-02-10'::date, 'bills', 'SimCard', 3.00),
    ('2026-02-11'::date, 'food', 'Lemon Tea', 1.00),
    ('2026-02-11'::date, 'transpo', 'Motor Gasoline', 4.20),
    ('2026-02-12'::date, 'food', 'Cafe', 2.00),
    ('2026-02-12'::date, 'bills', 'Medicine', 1.13),
    ('2026-02-13'::date, 'bills', 'Motor Oil', 5.50),
    ('2026-02-13'::date, 'food', 'Mineral water', 3.00),
    ('2026-02-13'::date, 'bills', 'Health Checkup', 13.75),
    ('2026-02-14'::date, 'bills', 'ill Treatment', 50.00),
    ('2026-02-15'::date, 'bills', 'ill Treatment + Support Mom', 50.00),
    ('2026-02-15'::date, 'bills', 'Haircut', 1.50),
    ('2026-02-16'::date, 'food', 'Drink', 1.43),
    ('2026-02-16'::date, 'food', 'Snack', 0.88),
    ('2026-02-16'::date, 'food', 'Mineral Water', 0.80),
    ('2026-02-17'::date, 'food', 'Drink', 2.00),
    ('2026-02-17'::date, 'food', 'Snack', 2.60),
    ('2026-02-17'::date, 'transpo', 'Motor Gasoline', 4.11),
    ('2026-02-18'::date, 'food', 'Drink', 1.60),
    ('2026-02-18'::date, 'food', 'Snack', 1.50),
    ('2026-02-18'::date, 'food', 'Mineral Water', 0.40),
    ('2026-02-18'::date, 'shop', 'Body Spray', 4.73),
    ('2026-02-18'::date, 'misc', 'Parking', 0.75),
    ('2026-02-19'::date, 'food', 'Drink', 1.26),
    ('2026-02-19'::date, 'misc', 'parking', 0.25),
    ('2026-02-19'::date, 'bills', 'Monthly support mom', 25.00),
    ('2026-02-19'::date, 'bills', 'Relative’s event', 20.00),
    ('2026-02-20'::date, 'transpo', 'Motor Gasoline', 3.52),
    ('2026-02-20'::date, 'food', 'Snack', 0.50),
    ('2026-02-20'::date, 'shop', 'Screen Mobile', 5.00),
    ('2026-02-20'::date, 'food', 'Lunch', 5.10),
    ('2026-02-20'::date, 'bills', 'WiFi', 15.00),
    ('2026-02-21'::date, 'bills', 'Monthly Party', 13.32),
    ('2026-02-21'::date, 'bills', 'Motor Washing', 0.75),
    ('2026-02-21'::date, 'shop', 'Insect Kill Spray', 2.75),
    ('2026-02-22'::date, 'bills', 'Water Payment', 0.75),
    ('2026-02-22'::date, 'food', 'Snack', 0.75),
    ('2026-02-23'::date, 'food', 'Drink', 1.26),
    ('2026-02-23'::date, 'misc', 'Parking', 0.25),
    ('2026-02-23'::date, 'food', 'Snack', 0.50),
    ('2026-02-23'::date, 'food', 'Drink', 0.75),
    ('2026-02-23'::date, 'transpo', 'Motor Gasoline', 4.28),
    ('2026-02-24'::date, 'food', 'Drink', 2.00),
    ('2026-02-24'::date, 'food', 'Snack', 0.50),
    ('2026-02-24'::date, 'misc', 'Parking', 0.63),
    ('2026-02-24'::date, 'food', 'Dinner with babe❤️', 4.25),
    ('2026-02-25'::date, 'food', 'Drink', 1.26),
    ('2026-02-25'::date, 'food', 'Egg', 0.50),
    ('2026-02-25'::date, 'food', 'Drink', 1.58),
    ('2026-02-25'::date, 'misc', 'Parking', 0.25),
    ('2026-02-26'::date, 'food', 'Drink', 1.76),
    ('2026-02-26'::date, 'shop', 'Clothes', 34.00),
    ('2026-02-26'::date, 'bills', 'Tea time with team', 5.12),
    ('2026-02-26'::date, 'transpo', 'Motor Gasoline', 4.22),
    ('2026-02-27'::date, 'food', 'Drink', 1.63),
    ('2026-02-27'::date, 'food', 'Snack', 3.45),
    ('2026-02-27'::date, 'food', 'Dinner', 1.50),
    ('2026-02-28'::date, 'food', 'Snack', 0.75),
    ('2026-02-28'::date, 'shop', 'Mask', 0.88),
    ('2026-02-28'::date, 'food', 'Dinner', 6.13),
    ('2026-02-28'::date, 'food', 'Cafe', 3.76),
    ('2026-02-28'::date, 'bills', 'Korean Exam', 19.00),
    ('2026-03-01'::date, 'bills', 'Hair cut', 1.50),
    ('2026-03-01'::date, 'food', 'Snack', 1.00),
    ('2026-03-01'::date, 'transpo', 'Motor gasoline', 3.34),
    ('2026-03-02'::date, 'food', 'Drink', 1.43),
    ('2026-03-02'::date, 'bills', 'Card phone number', 6.00),
    ('2026-03-03'::date, 'food', 'Drink', 1.60),
    ('2026-03-04'::date, 'food', 'Drink', 1.26),
    ('2026-03-04'::date, 'food', 'Snack', 0.50),
    ('2026-03-04'::date, 'transpo', 'Motor gasoline', 2.47),
    ('2026-03-05'::date, 'food', 'Drink', 1.43),
    ('2026-03-05'::date, 'food', 'Dinner with my babe', 5.25),
    ('2026-03-05'::date, 'food', 'Snack', 0.50),
    ('2026-03-05'::date, 'bills', 'Phone Card', 1.00),
    ('2026-03-05'::date, 'bills', 'EarPhone for my babe', 2.70),
    ('2026-03-06'::date, 'transpo', 'Motor gasoline', 3.62),
    ('2026-03-06'::date, 'food', 'Dinner with my babe', 13.50),
    ('2026-03-07'::date, 'food', 'Drink', 1.88),
    ('2026-03-07'::date, 'food', 'Snack', 0.75),
    ('2026-03-07'::date, 'bills', 'Change motor oil', 5.50),
    ('2026-03-08'::date, 'food', 'Snack', 0.75),
    ('2026-03-09'::date, 'food', 'Drink', 2.40),
    ('2026-03-09'::date, 'food', 'Snack', 0.50),
    ('2026-03-10'::date, 'transpo', 'Motor Gasoline', 3.54),
    ('2026-03-10'::date, 'food', 'Drink', 1.26),
    ('2026-03-10'::date, 'bills', 'medicine', 1.50),
    ('2026-03-11'::date, 'food', 'Drink', 2.00),
    ('2026-03-11'::date, 'misc', 'Parking', 0.50),
    ('2026-03-12'::date, 'food', 'Drink', 1.26),
    ('2026-03-12'::date, 'food', 'Dinner with babe', 6.00),
    ('2026-03-12'::date, 'bills', 'Medicine for mom', 0.63),
    ('2026-03-13'::date, 'transpo', 'Motor Gasoline', 5.71),
    ('2026-03-13'::date, 'food', 'Water', 0.25),
    ('2026-03-13'::date, 'food', 'Drink', 1.26),
    ('2026-03-13'::date, 'food', 'Dinner with babe', 12.50),
    ('2026-03-14'::date, 'bills', 'Phone Card', 1.00),
    ('2026-03-15'::date, 'bills', 'Hair cut', 1.50),
    ('2026-03-15'::date, 'bills', 'Motor Wash', 0.75),
    ('2026-03-15'::date, 'food', 'Dinner with babe', 14.85),
    ('2026-03-15'::date, 'shop', 'Body Spray (19400R)', 4.85),
    ('2026-03-15'::date, 'food', 'Drink (7600R)', 1.90),
    ('2026-03-16'::date, 'food', 'Drink', 2.00),
    ('2026-03-16'::date, 'food', 'Snack', 0.50),
    ('2026-03-16'::date, 'misc', 'Parking', 0.50),
    ('2026-03-17'::date, 'transpo', 'Motor Gasoline', 5.79),
    ('2026-03-17'::date, 'food', 'Drink', 2.00),
    ('2026-03-17'::date, 'food', 'Snack', 1.05),
    ('2026-03-18'::date, 'food', 'Drink', 1.26),
    ('2026-03-19'::date, 'bills', 'Monthly Support mom', 50.00),
    ('2026-03-19'::date, 'food', 'Drink', 2.00),
    ('2026-03-19'::date, 'food', 'Dinner with babe', 8.38),
    ('2026-03-20'::date, 'transpo', 'Motor Gasoline', 5.85),
    ('2026-03-20'::date, 'food', 'Lunch with babe', 3.90),
    ('2026-03-20'::date, 'food', 'Dinner', 5.25),
    ('2026-03-20'::date, 'misc', 'Parking', 0.25),
    ('2026-03-21'::date, 'food', 'Snack', 0.75),
    ('2026-03-21'::date, 'shop', 'Buy builder material', 2.50),
    ('2026-03-23'::date, 'food', 'Lunch', 0.50),
    ('2026-03-23'::date, 'bills', 'Water payment', 0.25),
    ('2026-03-24'::date, 'bills', 'Pay team for Coffee', 16.25),
    ('2026-03-24'::date, 'food', 'Drink', 2.30),
    ('2026-03-24'::date, 'food', 'Dinner', 2.00),
    ('2026-03-25'::date, 'transpo', 'Motor Gasoline', 6.13),
    ('2026-03-25'::date, 'food', 'Drink', 0.80),
    ('2026-03-25'::date, 'food', 'Dinner with babe', 1.75),
    ('2026-03-25'::date, 'bills', 'WiFi internet', 15.00),
    ('2026-03-26'::date, 'food', 'Dinner with babe', 1.50),
    ('2026-03-26'::date, 'food', 'Dinner', 2.00),
    ('2026-03-26'::date, 'bills', 'Medicine', 2.00),
    ('2026-03-26'::date, 'food', 'Drink', 1.60),
    ('2026-03-27'::date, 'food', 'Drink', 1.26),
    ('2026-03-27'::date, 'food', 'Dinner with babe', 10.78),
    ('2026-03-27'::date, 'food', 'KTV with babe', 4.48),
    ('2026-03-27'::date, 'misc', 'Parking', 0.75),
    ('2026-03-28'::date, 'transpo', 'Motor Gasoline', 5.74),
    ('2026-03-28'::date, 'food', 'Coffee', 1.88),
    ('2026-03-29'::date, 'bills', 'Haircut', 1.50),
    ('2026-03-30'::date, 'food', 'Dinner with babe', 1.75),
    ('2026-03-30'::date, 'misc', 'Parking', 0.25),
    ('2026-03-30'::date, 'food', 'Drink', 1.26),
    ('2026-03-31'::date, 'food', 'Drink for my babe', 3.15),
    ('2026-03-31'::date, 'food', 'Drink', 2.26),
    ('2026-03-31'::date, 'food', 'Water', 0.25)
  ) as v (spent_on, category, note, amount_usd);

  -- ── assertions: roll everything back unless this matches the CSVs ───────
  select count(*), coalesce(sum(amount_usd), 0) into v_new, v_total
  from public.transactions
  where user_id = v_user and spent_on >= v_from and spent_on < v_to;

  if v_new <> 158 then
    raise exception 'expected 158 rows in Feb–Mar 2026, found %', v_new;
  end if;

  if v_total <> 719.46 then
    raise exception 'expected total 719.46, found %', v_total;
  end if;

  raise notice 'imported % rows totalling %', v_new, v_total;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- OPTIONAL — monthly budgets for the two new months
-- ═══════════════════════════════════════════════════════════════════════════
-- Your CSVs carry no budget, so none is created; the app will show those
-- months with no budget set. Fill in the numbers and run this if you want one.
--
-- insert into public.monthly_budgets (user_id, month, amount_usd)
-- values ('a60d2ff5-97b0-4c67-9f9b-b6cffed079f9', '2026-02', 000.00),
--        ('a60d2ff5-97b0-4c67-9f9b-b6cffed079f9', '2026-03', 000.00)
-- on conflict (user_id, month) do update set amount_usd = excluded.amount_usd;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — verify: monthly totals. Expected first two rows:
--
--   month     entries    spent
--   2026-02        76   419.95
--   2026-03        82   299.51
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
-- STEP 3 — verify: per-category totals. Expected for the two new months:
--
--   month       food  transpo    bills   social     shop     misc    total
--   2026-02   100.19    24.45   229.82        —    63.36     2.13   419.95
--   2026-03   140.64    42.19   107.08        —     7.35     2.25   299.51
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
  and spent_on >= date '2026-02-01'
  and spent_on <  date '2026-04-01'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER THE IMPORT
-- ═══════════════════════════════════════════════════════════════════════════
-- These rows are new on the server and have no counterpart in the browser
-- cache, so no id collision like the 2026-07-27 re-import had. Just pull to
-- refresh on the dashboard (or reload) and Feb/Mar 2026 appear in the month
-- picker. No need to clear site data.
