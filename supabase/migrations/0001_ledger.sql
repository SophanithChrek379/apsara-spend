-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — ledger schema
-- Run this in the Supabase SQL Editor, or `supabase db push` with the CLI.
--
-- Design notes:
--   • spent_on is a DATE, not a timestamptz. An expense is a calendar day, not
--     an instant. The client picks a local day; storing an instant would make
--     the UTC date drift a day behind in UTC+7 (Cambodia).
--   • user_id defaults to auth.uid() so inserts never need to send it, and RLS
--     rejects any attempt to write someone else's row.
--   • Anonymous Supabase users get role `authenticated` with is_anonymous=true,
--     so the policies below cover them. The `anon` role gets nothing.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── transactions ───────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  amount_usd  numeric(10,2) not null,
  category    text          not null,
  note        text          not null default '',
  spent_on    date          not null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint transactions_amount_range   check (amount_usd > 0 and amount_usd <= 9999.99),
  constraint transactions_category_valid  check (category in ('food','transpo','bills','social','shop','misc')),
  constraint transactions_note_len        check (char_length(note) <= 100)
);

-- Primary read pattern: "all of my rows for a month, newest first".
create index if not exists transactions_user_spent_idx
  on public.transactions (user_id, spent_on desc);

-- ── monthly_budgets ────────────────────────────────────────────────────────
-- One budget per user per month. month is the app's existing "YYYY-MM" key.
create table if not exists public.monthly_budgets (
  user_id     uuid          not null default auth.uid() references auth.users (id) on delete cascade,
  month       text          not null,
  amount_usd  numeric(12,2) not null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  primary key (user_id, month),
  constraint monthly_budgets_month_fmt     check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint monthly_budgets_amount_range  check (amount_usd >= 0 and amount_usd <= 9999999.99)
);

-- ── updated_at maintenance ─────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transactions_touch on public.transactions;
create trigger transactions_touch
  before update on public.transactions
  for each row execute function public.touch_updated_at();

drop trigger if exists monthly_budgets_touch on public.monthly_budgets;
create trigger monthly_budgets_touch
  before update on public.monthly_budgets
  for each row execute function public.touch_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.transactions    enable row level security;
alter table public.monthly_budgets enable row level security;

drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists transactions_insert on public.transactions;
create policy transactions_insert on public.transactions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists transactions_update on public.transactions;
create policy transactions_update on public.transactions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists transactions_delete on public.transactions;
create policy transactions_delete on public.transactions
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists monthly_budgets_select on public.monthly_budgets;
create policy monthly_budgets_select on public.monthly_budgets
  for select to authenticated using (user_id = auth.uid());

drop policy if exists monthly_budgets_insert on public.monthly_budgets;
create policy monthly_budgets_insert on public.monthly_budgets
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists monthly_budgets_update on public.monthly_budgets;
create policy monthly_budgets_update on public.monthly_budgets
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists monthly_budgets_delete on public.monthly_budgets;
create policy monthly_budgets_delete on public.monthly_budgets
  for delete to authenticated using (user_id = auth.uid());
