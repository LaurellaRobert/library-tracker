-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- 1. Create the books table
create table public.books (
  id           uuid primary key default gen_random_uuid(),
  isbn         text not null,
  title        text not null,
  author       text,
  publisher    text,
  publish_year text,
  cover_url    text,
  owner        text not null default 'Shared',
  notes        text,
  added_at     timestamptz not null default now()
);

-- 2. Index on ISBN for fast duplicate checks
create index idx_books_isbn on public.books (isbn);

-- 3. Enable Row Level Security (required by Supabase)
alter table public.books enable row level security;

-- 4. For now (no auth), allow all operations via the anon key.
--    When you add auth later, replace these with user-scoped policies.
create policy "Allow public read"
  on public.books for select
  using (true);

create policy "Allow public insert"
  on public.books for insert
  with check (true);

create policy "Allow public delete"
  on public.books for delete
  using (true);
