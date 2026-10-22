create extension if not exists pgcrypto;

-- Fresh start only (drops data!): drop table if exists token_events, link_codes, devices cascade;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.link_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists public.token_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
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
  unique (device_id, turn_id)
);
create index if not exists token_events_user_ts_idx on public.token_events (user_id, ts desc);

alter table public.devices enable row level security;
alter table public.link_codes enable row level security;
alter table public.token_events enable row level security;

-- Signed-in users read only their own rows; all writes go through the functions below.
create policy "own devices read" on public.devices for select to authenticated using (user_id = auth.uid());
create policy "own devices update" on public.devices for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own devices delete" on public.devices for delete to authenticated using (user_id = auth.uid());
create policy "own events read" on public.token_events for select to authenticated using (user_id = auth.uid());
revoke update on public.devices from authenticated;
grant update (name, revoked) on public.devices to authenticated;

-- The admin page calls this (signed in): returns a one-time code, valid 10 minutes.
create or replace function public.create_link_code(p_device_name text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare c text := upper(encode(gen_random_bytes(5), 'hex'));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_device_name, ''))) = 0 then raise exception 'device name required'; end if;
  if (select count(*) from link_codes where user_id = auth.uid() and used_at is null and expires_at > now()) >= 5 then
    raise exception 'too many open codes';
  end if;
  insert into link_codes(code_hash, user_id, device_name, expires_at)
  values (encode(digest(c, 'sha256'), 'hex'), auth.uid(), left(trim(p_device_name), 60), now() + interval '10 minutes');
  return c;
end $$;
revoke all on function public.create_link_code(text) from public, anon;
grant execute on function public.create_link_code(text) to authenticated;

-- The `link` Edge Function (service role) calls this: spends the code once, creates the device.
create or replace function public.redeem_link_code(p_code_hash text, p_token_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare r link_codes;
begin
  update link_codes set used_at = now()
   where code_hash = p_code_hash and used_at is null and expires_at > now()
   returning * into r;
  if not found then return null; end if;
  insert into devices(user_id, name, token_hash) values (r.user_id, r.device_name, p_token_hash);
  return r.device_name;
end $$;
revoke all on function public.redeem_link_code(text, text) from public, anon, authenticated;
grant execute on function public.redeem_link_code(text, text) to service_role;
