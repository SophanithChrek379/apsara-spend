-- ═══════════════════════════════════════════════════════════════════════════
-- Apsara Spend — annual income (salary)
-- Run this in the Supabase SQL Editor, or `supabase db push` with the CLI.
--
-- One row per user per calendar year. Salary changes from year to year, so a
-- year is the unit of entry; the report spreads it evenly across that year's
-- months (amount ÷ 12) when comparing it with spending.
--
-- Deliberately NOT part of the ledger payload (/api/ledger, /api/sync) and
-- never written to the client's localStorage cache. The client fetches it from
-- /api/income only after a successful Face ID / device unlock, so the figure is
-- never sitting in memory or on disk while the report is locked.
--
-- RUN THIS BEFORE DEPLOYING THE CLIENT. Until the table exists, /api/income
-- returns 500 and the report's income card shows its error state — nothing else
-- in the app depends on it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.annual_income (
  user_id     uuid          not null default auth.uid() references auth.users (id) on delete cascade,
  year        integer       not null,
  amount_usd  numeric(12,2) not null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  primary key (user_id, year),
  constraint annual_income_year_range    check (year between 2000 and 2100),
  constraint annual_income_amount_range  check (amount_usd > 0 and amount_usd <= 99999999.99)
);

drop trigger if exists annual_income_touch on public.annual_income;
create trigger annual_income_touch
  before update on public.annual_income
  for each row execute function public.touch_updated_at();

alter table public.annual_income enable row level security;

drop policy if exists annual_income_select on public.annual_income;
create policy annual_income_select on public.annual_income
  for select to authenticated using (user_id = auth.uid());

drop policy if exists annual_income_insert on public.annual_income;
create policy annual_income_insert on public.annual_income
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists annual_income_update on public.annual_income;
create policy annual_income_update on public.annual_income
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists annual_income_delete on public.annual_income;
create policy annual_income_delete on public.annual_income
  for delete to authenticated using (user_id = auth.uid());
