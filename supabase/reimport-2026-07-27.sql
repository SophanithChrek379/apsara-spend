-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — full ledger re-import
--
-- Source : apsara-spend-2026-07-27.csv (exported from the web app)
-- Content: 295 transactions · $1722.29 total · 4 monthly budgets
--
-- Run the four steps below IN ORDER in the Supabase SQL Editor.
--   STEP 0  find your user id                     → copy the id it returns
--   STEP 1  paste that id into v_user, then run   → wipes + re-imports
--   STEP 2  paste the same id, then run           → monthly totals by spent_on
--   STEP 3  paste the same id, then run           → per-category totals by month
--
-- STEP 1 is a single transaction with assertions at the end. If the counts or
-- the total do not match the CSV, it raises and the whole block rolls back —
-- your existing data is left exactly as it was.
--
-- ON IDS: the CSV ids are legacy `Date.now()+random` strings from before the DB
-- existed. They are not uuids, so they cannot be primary keys. Every row gets a
-- fresh gen_random_uuid(). See "AFTER THE IMPORT" at the bottom — there is one
-- required cleanup step in the browser.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 0 — confirm the target user before wiping anything
-- ═══════════════════════════════════════════════════════════════════════════
-- The user id below is already filled in throughout this script:
--   a60d2ff5-97b0-4c67-9f9b-b6cffed079f9   (real device, mobile browser)
--
-- Run this first and read the row. tx_count / budget_count is what STEP 1 is
-- about to delete. If the id returns no row at all, stop — the anonymous
-- identity was replaced and you need the new one.

select u.id,
       u.is_anonymous,
       u.created_at,
       u.last_sign_in_at,
       (select count(*) from public.transactions    t where t.user_id = u.id) as tx_count,
       (select count(*) from public.monthly_budgets b where b.user_id = u.id) as budget_count
from auth.users u
where u.id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';

-- If that returned nothing, list them all and pick by tx_count instead:
--   select u.id, u.is_anonymous, u.created_at, u.last_sign_in_at,
--          (select count(*) from public.transactions t where t.user_id = u.id) as tx_count
--   from auth.users u
--   order by u.last_sign_in_at desc nulls last;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 — wipe everything for that user, then re-import the CSV
-- ═══════════════════════════════════════════════════════════════════════════
-- Run this whole block as one statement (select from `do $$` through `$$;`).
-- v_user is already set. Nothing to edit.

do $$
declare
  v_user    uuid := 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9';  -- real device / mobile browser
  v_old_tx  bigint;
  v_old_bud bigint;
  v_new_tx  bigint;
  v_new_bud bigint;
  v_total   numeric;
begin
  -- ── guards ──────────────────────────────────────────────────────────────
  if v_user = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Set v_user to your auth user id first (run STEP 0).';
  end if;

  if not exists (select 1 from auth.users where id = v_user) then
    raise exception 'No such user: %', v_user;
  end if;

  -- ── wipe ────────────────────────────────────────────────────────────────
  select count(*) into v_old_tx  from public.transactions    where user_id = v_user;
  select count(*) into v_old_bud from public.monthly_budgets where user_id = v_user;

  delete from public.transactions    where user_id = v_user;
  delete from public.monthly_budgets where user_id = v_user;

  raise notice 'deleted % transactions and % budgets', v_old_tx, v_old_bud;

  -- ── re-import: 295 transactions ─────────────────────────────────────────
  insert into public.transactions (user_id, spent_on, category, note, amount_usd)
  select v_user, v.spent_on, v.category, v.note, v.amount_usd
  from (values
    ('2026-04-01'::date, 'bills', 'Card phone number', 6.00),
    ('2026-04-01'::date, 'food', 'Drink', 1.60),
    ('2026-04-02'::date, 'bills', 'Card phone for mom', 1.00),
    ('2026-04-02'::date, 'transpo', 'Motor gasoline', 6.16),
    ('2026-04-02'::date, 'food', 'Dinner with babe', 1.75),
    ('2026-04-03'::date, 'food', 'Lunch', 4.84),
    ('2026-04-03'::date, 'food', 'Dinner with babe', 9.50),
    ('2026-04-03'::date, 'food', 'Pub with babe', 6.84),
    ('2026-04-04'::date, 'food', 'Drink for my family', 2.25),
    ('2026-04-05'::date, 'shop', 'Motor wash', 0.75),
    ('2026-04-05'::date, 'bills', 'Change motor oil', 8.00),
    ('2026-04-06'::date, 'misc', 'Parking', 0.25),
    ('2026-04-06'::date, 'bills', 'Korean class payment', 11.20),
    ('2026-04-06'::date, 'food', 'Drink', 1.00),
    ('2026-04-06'::date, 'food', 'Dinner with babe', 2.26),
    ('2026-04-06'::date, 'transpo', 'Motor Gasoline', 5.80),
    ('2026-04-07'::date, 'food', 'Drink', 1.26),
    ('2026-04-07'::date, 'food', 'Dinner with babe', 1.76),
    ('2026-04-08'::date, 'food', 'Dinner with babe', 1.76),
    ('2026-04-08'::date, 'food', 'Drink: Banana Milk', 1.60),
    ('2026-04-09'::date, 'food', 'Drink with my babe', 1.80),
    ('2026-04-09'::date, 'transpo', 'Motor Gasoline', 5.08),
    ('2026-04-09'::date, 'food', 'Drink', 1.80),
    ('2026-04-09'::date, 'food', 'Dinner with babe', 9.70),
    ('2026-04-10'::date, 'food', 'Drink with babe', 1.00),
    ('2026-04-10'::date, 'food', 'Dinner with babe', 18.50),
    ('2026-04-10'::date, 'food', 'Drink', 1.00),
    ('2026-04-10'::date, 'bills', 'Motel service', 8.00),
    ('2026-04-11'::date, 'food', 'Breakfast', 0.75),
    ('2026-04-12'::date, 'bills', 'Change motor oil and water', 8.00),
    ('2026-04-12'::date, 'food', 'Buy food ingredients', 0.63),
    ('2026-04-12'::date, 'shop', 'Haircut', 1.50),
    ('2026-04-13'::date, 'bills', 'Support Mom with my girlfriend’s parent for Khmer new year', 75.00),
    ('2026-04-13'::date, 'food', 'Drink', 0.50),
    ('2026-04-13'::date, 'food', 'Lunch with my babe', 4.87),
    ('2026-04-13'::date, 'food', 'Dinner with babe', 12.50),
    ('2026-04-13'::date, 'bills', 'Movie with babe', 13.00),
    ('2026-04-14'::date, 'transpo', 'Motor gasoline', 5.10),
    ('2026-04-14'::date, 'transpo', 'Tela Khmer Motor Gasoline', 4.59),
    ('2026-04-14'::date, 'shop', 'Men’s thing', 12.54),
    ('2026-04-14'::date, 'food', 'Drink', 2.14),
    ('2026-04-17'::date, 'bills', 'Monthly Support Mom', 50.00),
    ('2026-04-17'::date, 'food', 'Lunch', 19.05),
    ('2026-04-18'::date, 'transpo', 'Motor Gasoline', 4.33),
    ('2026-04-19'::date, 'food', 'Coconut Juice', 0.63),
    ('2026-04-19'::date, 'bills', 'Change motor oil', 5.50),
    ('2026-04-20'::date, 'food', 'Drink', 1.26),
    ('2026-04-20'::date, 'transpo', 'Motor Gasoline', 5.11),
    ('2026-04-21'::date, 'food', 'Drink', 1.63),
    ('2026-04-22'::date, 'bills', 'Monthly party with team', 7.26),
    ('2026-04-22'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-04-22'::date, 'food', 'Dinner with my babe', 2.26),
    ('2026-04-23'::date, 'bills', 'Water’s payment', 0.25),
    ('2026-04-23'::date, 'transpo', 'Motor Gasoline', 4.41),
    ('2026-04-23'::date, 'food', 'Dinner with my babe', 5.25),
    ('2026-04-23'::date, 'misc', 'Motor Parking', 0.38),
    ('2026-04-24'::date, 'food', 'Drink with my babe', 1.43),
    ('2026-04-24'::date, 'bills', 'Motel Service', 8.00),
    ('2026-04-24'::date, 'food', 'Dinner with my babe', 7.80),
    ('2026-04-25'::date, 'bills', 'WiFi payment', 15.00),
    ('2026-04-25'::date, 'food', 'Breakfast', 0.75),
    ('2026-04-27'::date, 'bills', 'Colleagues’s wedding', 20.00),
    ('2026-04-28'::date, 'transpo', 'Motor gasoline', 5.65),
    ('2026-04-28'::date, 'food', 'Drink with Snack with my babe', 1.76),
    ('2026-04-29'::date, 'food', 'Snack with babe', 1.01),
    ('2026-04-29'::date, 'food', 'Drink with babe', 0.40),
    ('2026-04-29'::date, 'misc', 'Motor Parking', 0.25),
    ('2026-04-30'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-04-30'::date, 'food', 'Snack with my babe', 2.01),
    ('2026-04-30'::date, 'food', 'Pub with my babe', 8.00),
    ('2026-04-30'::date, 'bills', 'Motel Service', 8.00),
    ('2026-05-01'::date, 'bills', 'Phone card', 6.00),
    ('2026-05-01'::date, 'transpo', 'Motor gasoline', 5.47),
    ('2026-05-02'::date, 'food', 'Drink', 1.25),
    ('2026-05-04'::date, 'food', 'Breakfast with babe', 0.75),
    ('2026-05-04'::date, 'shop', 'Buy shoes for me and my babe', 57.00),
    ('2026-05-04'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-05-04'::date, 'bills', 'Korean Class Payment', 11.20),
    ('2026-05-04'::date, 'bills', 'Motel service', 8.00),
    ('2026-05-04'::date, 'food', 'Beer with my babe', 2.50),
    ('2026-05-04'::date, 'food', 'Snack with my babe', 0.88),
    ('2026-05-05'::date, 'bills', 'Hair cut', 1.50),
    ('2026-05-05'::date, 'bills', 'Motor wash', 0.75),
    ('2026-05-06'::date, 'food', 'Breakfast with babe', 0.75),
    ('2026-05-06'::date, 'transpo', 'Motor Gasoline', 4.87),
    ('2026-05-06'::date, 'food', 'Water minerals', 0.40),
    ('2026-05-06'::date, 'misc', 'Parking Motor', 0.25),
    ('2026-05-07'::date, 'food', 'Breakfast with babe', 0.75),
    ('2026-05-07'::date, 'food', 'Drink with babe', 1.26),
    ('2026-05-07'::date, 'food', 'Dinner with babe', 7.80),
    ('2026-05-08'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-05-08'::date, 'food', 'Pub with my babe', 16.10),
    ('2026-05-08'::date, 'bills', 'Motel service', 8.00),
    ('2026-05-10'::date, 'food', 'Breakfast', 0.63),
    ('2026-05-11'::date, 'transpo', 'Motor gasoline', 5.11),
    ('2026-05-11'::date, 'food', 'Drink with babe', 1.26),
    ('2026-05-11'::date, 'food', 'Snack with my babe', 0.50),
    ('2026-05-11'::date, 'food', 'Mineral water', 0.40),
    ('2026-05-12'::date, 'food', 'Coffee', 1.00),
    ('2026-05-12'::date, 'food', 'Drink with my babe', 1.60),
    ('2026-05-12'::date, 'misc', 'Motor parking', 0.25),
    ('2026-05-12'::date, 'food', 'Mineral water', 0.40),
    ('2026-05-12'::date, 'food', 'Pumpkin water for my babe', 0.63),
    ('2026-05-13'::date, 'food', 'Drink with my babe', 1.63),
    ('2026-05-13'::date, 'food', 'Dinner with my babe', 4.13),
    ('2026-05-13'::date, 'bills', 'Motel service', 8.00),
    ('2026-05-14'::date, 'transpo', 'Motor gasoline', 2.50),
    ('2026-05-14'::date, 'food', 'Breakfast', 1.00),
    ('2026-05-14'::date, 'food', 'Water melon for lunch', 1.25),
    ('2026-05-15'::date, 'bills', 'Monthly party with colleagues', 9.00),
    ('2026-05-15'::date, 'food', 'Drink with my babe', 1.63),
    ('2026-05-15'::date, 'food', 'Dinner for my babe’s family', 14.25),
    ('2026-05-16'::date, 'misc', 'Haircut', 1.50),
    ('2026-05-17'::date, 'transpo', 'Motor gasoline', 5.12),
    ('2026-05-17'::date, 'food', 'Cafe with babe', 3.76),
    ('2026-05-17'::date, 'food', 'Lunch with babe', 5.75),
    ('2026-05-17'::date, 'bills', 'Motel service', 8.00),
    ('2026-05-18'::date, 'food', 'Drink with my babe', 1.60),
    ('2026-05-18'::date, 'misc', 'Motor parking', 0.25),
    ('2026-05-18'::date, 'food', 'Dinner with my babe', 8.00),
    ('2026-05-19'::date, 'social', 'Monthly support mom', 50.00),
    ('2026-05-19'::date, 'food', 'Drink with my babe', 0.63),
    ('2026-05-19'::date, 'misc', 'Motor parking', 0.25),
    ('2026-05-19'::date, 'shop', 'Body spray and toothpaste', 6.29),
    ('2026-05-20'::date, 'transpo', 'Motor gasoline', 5.74),
    ('2026-05-20'::date, 'food', 'Drink for my babe', 1.00),
    ('2026-05-21'::date, 'shop', 'Medicine for my sickness', 3.75),
    ('2026-05-21'::date, 'food', 'Breakfast', 1.50),
    ('2026-05-22'::date, 'food', 'Drink for my babe', 0.63),
    ('2026-05-22'::date, 'food', 'Dinner with my babe', 5.50),
    ('2026-05-22'::date, 'misc', 'Motor parking', 0.25),
    ('2026-05-23'::date, 'bills', 'Change Motor oil', 5.50),
    ('2026-05-23'::date, 'food', 'Breakfast', 1.25),
    ('2026-05-25'::date, 'food', 'Drink for my babe', 0.63),
    ('2026-05-25'::date, 'misc', 'Motor parking', 0.25),
    ('2026-05-25'::date, 'food', 'Mineral water', 0.40),
    ('2026-05-25'::date, 'transpo', 'Motor gasoline', 5.56),
    ('2026-05-26'::date, 'food', 'Drink with babe', 1.26),
    ('2026-05-26'::date, 'food', 'Dinner with babe', 5.85),
    ('2026-05-26'::date, 'bills', 'Wi-Fi paid', 15.00),
    ('2026-05-27'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-05-27'::date, 'shop', 'Cut jean’s pant pair service', 1.25),
    ('2026-05-28'::date, 'food', 'Breakfast with my babe', 1.75),
    ('2026-05-28'::date, 'food', 'Drink with my babe', 1.50),
    ('2026-05-29'::date, 'food', 'Snack with my babe', 0.55),
    ('2026-05-29'::date, 'food', 'Drink with my babe', 1.05),
    ('2026-05-29'::date, 'transpo', 'Motor gasoline', 5.96),
    ('2026-05-29'::date, 'food', 'Dinner with babe', 5.99),
    ('2026-05-30'::date, 'food', 'Buy Umbrella', 3.00),
    ('2026-05-30'::date, 'bills', 'Koh Rong’s motel service', 15.00),
    ('2026-05-31'::date, 'bills', 'Motor service at Koh rong', 7.50),
    ('2026-06-01'::date, 'bills', 'Phone number monthly', 6.00),
    ('2026-06-01'::date, 'shop', 'Buy jacket', 46.00),
    ('2026-06-02'::date, 'bills', 'Haircut', 1.50),
    ('2026-06-02'::date, 'bills', 'Add-on money for Koh Rong trip', 3.10),
    ('2026-06-02'::date, 'food', 'Buy durian as yearly eating with family', 17.50),
    ('2026-06-02'::date, 'misc', 'Motor wash', 0.75),
    ('2026-06-02'::date, 'food', 'Mineral water', 0.40),
    ('2026-06-02'::date, 'misc', 'Motor parking', 0.25),
    ('2026-06-03'::date, 'food', 'Breakfast Snack with my babe', 0.75),
    ('2026-06-03'::date, 'food', 'Drink with my babe', 1.63),
    ('2026-06-03'::date, 'transpo', 'Motor gasoline', 5.49),
    ('2026-06-03'::date, 'food', 'Mineral water', 0.25),
    ('2026-06-04'::date, 'food', 'Drink with my babe', 1.43),
    ('2026-06-04'::date, 'food', 'Drink with my babe', 1.00),
    ('2026-06-05'::date, 'food', 'Dinner with my babe', 5.80),
    ('2026-06-05'::date, 'bills', 'Flu medicine', 1.13),
    ('2026-06-08'::date, 'transpo', 'Motor gasoline', 5.25),
    ('2026-06-08'::date, 'social', 'Korean class payment', 11.20),
    ('2026-06-08'::date, 'bills', 'Lovable site payment', 25.00),
    ('2026-06-09'::date, 'food', 'Lunch food', 1.75),
    ('2026-06-09'::date, 'food', 'Drink with babe', 1.26),
    ('2026-06-09'::date, 'food', 'Snack with my babe', 1.50),
    ('2026-06-09'::date, 'food', 'Dinner with my babe', 5.50),
    ('2026-06-10'::date, 'bills', 'Motel service with babe', 8.00),
    ('2026-06-10'::date, 'food', 'Breakfast with my babe', 1.25),
    ('2026-06-11'::date, 'food', 'Drink with my babe', 1.60),
    ('2026-06-11'::date, 'shop', 'Buy body spray and some staff', 7.51),
    ('2026-06-12'::date, 'food', 'Cafe with my babe', 2.00),
    ('2026-06-12'::date, 'food', '5 months anniversary dating dinner with babe', 20.50),
    ('2026-06-13'::date, 'transpo', 'Motor gasoline', 5.23),
    ('2026-06-14'::date, 'bills', 'Buy sick’s medicine', 5.00),
    ('2026-06-15'::date, 'food', 'Drink with babe', 1.26),
    ('2026-06-15'::date, 'food', 'Drink with babe', 1.19),
    ('2026-06-15'::date, 'food', 'Dinner with babe', 2.00),
    ('2026-06-16'::date, 'food', 'Mineral water', 0.25),
    ('2026-06-16'::date, 'food', 'Dinner with babe', 1.75),
    ('2026-06-17'::date, 'food', 'Drink with babe', 1.60),
    ('2026-06-17'::date, 'food', 'Drink at Eden park', 1.75),
    ('2026-06-17'::date, 'transpo', 'Motor gasoline', 5.08),
    ('2026-06-17'::date, 'food', 'Dinner with babe', 4.00),
    ('2026-06-17'::date, 'bills', 'Motel service', 8.00),
    ('2026-06-18'::date, 'food', 'Breakfast', 1.25),
    ('2026-06-18'::date, 'food', 'Lunch', 3.00),
    ('2026-06-18'::date, 'food', 'Maxim drink', 0.50),
    ('2026-06-18'::date, 'bills', 'Buy Shampoo', 4.00),
    ('2026-06-19'::date, 'food', 'Eggs for breakfast with babe', 0.50),
    ('2026-06-19'::date, 'food', 'Dinner with babe', 13.50),
    ('2026-06-20'::date, 'food', 'Breakfast', 0.75),
    ('2026-06-20'::date, 'misc', 'Buy ice', 0.25),
    ('2026-06-21'::date, 'food', 'Snack', 0.75),
    ('2026-06-21'::date, 'bills', 'Hair cut', 1.50),
    ('2026-06-22'::date, 'transpo', 'Motor gasoline', 4.73),
    ('2026-06-22'::date, 'food', 'Snack with my babe', 1.15),
    ('2026-06-22'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-06-22'::date, 'misc', 'Motor parking', 0.25),
    ('2026-06-23'::date, 'misc', 'Motor parking', 0.25),
    ('2026-06-23'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-06-23'::date, 'food', 'Drink for jogging with babe', 1.75),
    ('2026-06-24'::date, 'food', 'Drink with my babe', 1.60),
    ('2026-06-25'::date, 'transpo', 'Motor gasoline', 4.59),
    ('2026-06-25'::date, 'food', 'Dinner with my babe and her sister', 8.00),
    ('2026-06-25'::date, 'food', 'Drink with my babe', 1.63),
    ('2026-06-26'::date, 'food', 'Drink with babe', 1.63),
    ('2026-06-26'::date, 'food', 'Dinner with my babe', 7.80),
    ('2026-06-26'::date, 'food', 'Snack with drink for my babe and I', 2.65),
    ('2026-06-26'::date, 'bills', 'Motel Service', 8.00),
    ('2026-06-26'::date, 'bills', 'Monthly WiFi', 15.00),
    ('2026-06-27'::date, 'food', 'Change motor pil', 8.00),
    ('2026-06-27'::date, 'food', 'Breakfast', 1.50),
    ('2026-06-27'::date, 'food', 'Coffee with my mom', 3.75),
    ('2026-06-28'::date, 'transpo', 'Motor gasoline', 3.64),
    ('2026-06-29'::date, 'food', 'Drink with my babe', 1.63),
    ('2026-06-29'::date, 'food', 'Dinner with babe', 2.25),
    ('2026-06-30'::date, 'food', 'Drink with my babe', 1.26),
    ('2026-06-30'::date, 'food', 'Dinner with babe', 2.00),
    ('2026-07-01'::date, 'bills', 'Card phone number', 6.00),
    ('2026-07-01'::date, 'food', 'Drink with babe', 1.75),
    ('2026-07-01'::date, 'food', 'Drink with babe', 1.26),
    ('2026-07-01'::date, 'misc', 'Motor parking', 0.25),
    ('2026-07-02'::date, 'transpo', 'Motor gasoline', 4.30),
    ('2026-07-02'::date, 'food', 'Drink with babe', 1.26),
    ('2026-07-02'::date, 'food', 'Dinner with babe', 5.50),
    ('2026-07-02'::date, 'misc', 'Motor parking', 0.25),
    ('2026-07-03'::date, 'food', 'Drink with babe', 1.70),
    ('2026-07-03'::date, 'food', 'Pub with babe', 14.40),
    ('2026-07-03'::date, 'food', 'Durian for my family', 14.63),
    ('2026-07-03'::date, 'bills', 'Motel service with babe', 8.00),
    ('2026-07-03'::date, 'misc', 'Motor parking', 0.13),
    ('2026-07-04'::date, 'shop', 'Motor wash', 0.75),
    ('2026-07-04'::date, 'bills', 'Hair cut', 1.50),
    ('2026-07-05'::date, 'shop', 'Buy helmet', 35.00),
    ('2026-07-05'::date, 'shop', 'Buy motor sock', 5.00),
    ('2026-07-05'::date, 'transpo', 'Motor Gasoline', 3.92),
    ('2026-07-05'::date, 'food', 'Lunch for me and brother', 3.00),
    ('2026-07-05'::date, 'shop', 'Body perfume', 3.94),
    ('2026-07-06'::date, 'food', 'Breakfast', 1.50),
    ('2026-07-06'::date, 'food', 'Coffee for babe', 0.85),
    ('2026-07-06'::date, 'shop', 'Buy raincoat', 0.50),
    ('2026-07-06'::date, 'shop', 'Medicine flu', 1.25),
    ('2026-07-06'::date, 'bills', 'Trip contributions money', 14.63),
    ('2026-07-07'::date, 'food', 'Drink with babe', 1.48),
    ('2026-07-07'::date, 'bills', 'Medicine for flu', 1.00),
    ('2026-07-08'::date, 'food', 'Snack for my babe', 0.55),
    ('2026-07-08'::date, 'food', 'Drink for my babe', 0.83),
    ('2026-07-09'::date, 'shop', 'Medicine', 1.50),
    ('2026-07-09'::date, 'food', 'Mineral water', 0.38),
    ('2026-07-09'::date, 'food', 'Drink for my babe', 0.85),
    ('2026-07-09'::date, 'transpo', 'Motor gasoline', 4.67),
    ('2026-07-10'::date, 'food', 'Lunch', 1.75),
    ('2026-07-10'::date, 'food', 'Coffee for my babe', 0.85),
    ('2026-07-10'::date, 'food', 'Dinner with babe', 3.00),
    ('2026-07-10'::date, 'bills', 'Blood test service', 16.25),
    ('2026-07-11'::date, 'food', 'Drink', 0.85),
    ('2026-07-11'::date, 'transpo', 'Grab service', 1.77),
    ('2026-07-11'::date, 'food', 'Drink with my babe', 6.60),
    ('2026-07-11'::date, 'transpo', 'Grab service', 1.70),
    ('2026-07-12'::date, 'food', 'Breakfast with babe', 3.25),
    ('2026-07-12'::date, 'food', 'Mineral water', 1.00),
    ('2026-07-12'::date, 'food', 'Brown Independent Kompong Soam', 7.30),
    ('2026-07-12'::date, 'food', 'Snack with babe', 2.25),
    ('2026-07-13'::date, 'food', 'Drink for my babe', 0.85),
    ('2026-07-13'::date, 'food', 'Lunch', 1.75),
    ('2026-07-13'::date, 'food', 'Drink for my babe', 0.85),
    ('2026-07-13'::date, 'bills', 'Sickness Medicine treatment', 21.25),
    ('2026-07-13'::date, 'shop', 'Body spray', 4.90),
    ('2026-07-15'::date, 'food', 'Drink with babe', 1.48),
    ('2026-07-15'::date, 'transpo', 'Motor gasoline', 3.41),
    ('2026-07-16'::date, 'food', 'Drink with my babe', 1.43),
    ('2026-07-16'::date, 'bills', 'Sickness treatment', 24.75),
    ('2026-07-17'::date, 'food', 'Drink with babe', 1.65),
    ('2026-07-17'::date, 'shop', 'Buy underwear', 15.50),
    ('2026-07-17'::date, 'food', 'Buy snack with babe', 1.47),
    ('2026-07-17'::date, 'bills', 'Medicine for sickness treatment', 4.98),
    ('2026-07-18'::date, 'bills', 'Nose and throat treatment bill', 175.61),
    ('2026-07-18'::date, 'bills', 'Buy stomach medicine', 2.49),
    ('2026-07-18'::date, 'shop', 'Buy mineral water', 6.25),
    ('2026-07-23'::date, 'transpo', 'Motor gasoline', 3.73),
    ('2026-07-24'::date, 'food', 'Breakfast', 1.00),
    ('2026-07-25'::date, 'bills', 'Nose Treatment medicine', 66.51),
    ('2026-07-25'::date, 'food', 'Coffee with babe', 4.86),
    ('2026-07-25'::date, 'bills', 'Motel service', 8.00),
    ('2026-07-25'::date, 'food', 'Dinner with babe', 7.80),
    ('2026-07-26'::date, 'food', 'Breakfast', 0.75),
    ('2026-07-26'::date, 'food', 'Snack', 1.25)
  ) as v (spent_on, category, note, amount_usd);

  -- ── re-import: 4 monthly budgets ───────────────────────────────────────
  insert into public.monthly_budgets (user_id, month, amount_usd)
  select v_user, v.month, v.amount_usd
  from (values
    ('2026-04', 453.48),
    ('2026-05', 383.20),
    ('2026-06', 350.00),
    ('2026-07', 650.00)
  ) as v (month, amount_usd);

  -- ── assertions — any mismatch rolls this entire block back ──────────────
  select count(*), coalesce(sum(amount_usd), 0)
    into v_new_tx, v_total
    from public.transactions where user_id = v_user;

  select count(*) into v_new_bud
    from public.monthly_budgets where user_id = v_user;

  if v_new_tx <> 295 then
    raise exception 'expected 295 transactions, got %', v_new_tx;
  end if;

  if v_total <> 1722.29 then
    raise exception 'expected total 1722.29, got %', v_total;
  end if;

  if v_new_bud <> 4 then
    raise exception 'expected 4 budgets, got %', v_new_bud;
  end if;

  raise notice 'imported % transactions ($%) and % budgets — OK', v_new_tx, v_total, v_new_bud;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — verify: monthly totals grouped by spent_on
-- ═══════════════════════════════════════════════════════════════════════════
-- Expected result:
--
--   month     entries    spent    budget   remaining
--   2026-04        71   453.48    453.48        0.00
--   2026-05        80   383.20    383.20        0.00
--   2026-06        75   333.99    350.00       16.01
--   2026-07        69   551.62    650.00       98.38

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
-- STEP 3 — verify: per-category totals by month
-- ═══════════════════════════════════════════════════════════════════════════
-- Cross-check against the app's month view. Expected result:
--
--   month       food  transpo    bills   social     shop     misc
--   2026-04   147.37    46.23   244.21     0.00    14.79     0.88
--   2026-05   118.13    40.33   103.45    50.00    68.29     3.00
--   2026-06   147.29    34.01    86.23    11.20    53.51     1.75
--   2026-07   101.93    23.50   350.97     0.00    74.59     0.63

select to_char(spent_on, 'YYYY-MM')                                as month,
       sum(amount_usd) filter (where category = 'food')    as food,
       sum(amount_usd) filter (where category = 'transpo') as transpo,
       sum(amount_usd) filter (where category = 'bills')   as bills,
       sum(amount_usd) filter (where category = 'social')  as social,
       sum(amount_usd) filter (where category = 'shop')    as shop,
       sum(amount_usd) filter (where category = 'misc')    as misc,
       sum(amount_usd)                                     as total,
       count(*)                                            as entries
from public.transactions
where user_id = 'a60d2ff5-97b0-4c67-9f9b-b6cffed079f9'
group by 1
order by 1;


-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER THE IMPORT — required browser cleanup
-- ═══════════════════════════════════════════════════════════════════════════
-- Every row now has a new uuid, but your browser's cached ledger still holds
-- the 295 rows under their old legacy ids. On the next boot the app treats
-- those as un-pushed local writes and merges them on top of what it pulls, so
-- you would see every entry twice.
--
-- Before reopening the app:
--   devtools → Application → Storage → Clear site data
--
-- Then reload. The app pulls the server ledger fresh and re-seeds its cache.
