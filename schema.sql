create table if not exists public.token_events (
  id bigint generated always as identity primary key,
  device text not null,
  session_id text not null,
  turn_id text not null,
  ts timestamptz not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_creation_tokens int not null default 0,
  duration_ms int not null default 0,
  is_subagent boolean not null default false,
  unique (device, turn_id)
);
create index if not exists token_events_ts_idx on public.token_events (ts desc);
alter table public.token_events enable row level security;
-- devices write with the anon key (insert only); reading is for the dashboard via an authenticated role
create policy "anon insert" on public.token_events for insert to anon with check (true);
