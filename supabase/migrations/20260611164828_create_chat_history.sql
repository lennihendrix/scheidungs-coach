-- Chat sessions table: one row per user, stores profile + full message history
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile jsonb not null default '{}',
  messages jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique(user_id)
);

alter table public.chat_sessions enable row level security;

create policy "Users can read own session"
  on public.chat_sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert own session"
  on public.chat_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own session"
  on public.chat_sessions for update
  using (auth.uid() = user_id);

create policy "Users can delete own session"
  on public.chat_sessions for delete
  using (auth.uid() = user_id);
