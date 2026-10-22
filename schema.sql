create extension if not exists pgcrypto;

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

create table if not exists public.devices (
  name text primary key,
  token_hash text not null unique,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

-- No policies: anon and authenticated roles cannot touch either table directly.
-- Writes go through the `ingest` Edge Function (service role); the dashboard reads via its own route.
alter table public.token_events enable row level security;
alter table public.devices enable row level security;

create or replace function public.create_device(p_name text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(gen_random_bytes(24), 'hex');
begin
  insert into devices(name, token_hash) values (p_name, encode(digest(t, 'sha256'), 'hex'));
  return t;
end $$;
revoke all on function public.create_device(text) from public, anon, authenticated;

-- Add a device:   select create_device('linux-home');   (copy the token, it is shown once)
-- Revoke one:     update devices set revoked = true where name = 'linux-home';
