create table public.profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '' check (char_length(display_name) <= 80),
 wallet text not null default '' check (wallet = '' or (wallet ~ '^0x[0-9a-fA-F]{40}$' and wallet <> '0x0000000000000000000000000000000000000000')),
 network text not null default 'robinhood' check (network in ('robinhood','ethereum','arbitrum')),
 confirm_transfers integer not null default 1 check (confirm_transfers in (0,1))
);
create table public.contacts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (char_length(trim(name)) between 1 and 80),
 phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
 address text not null check (address ~ '^0x[0-9a-fA-F]{40}$' and address <> '0x0000000000000000000000000000000000000000'),
 created bigint not null default ((extract(epoch from now()) * 1000)::bigint),
 unique (user_id,phone)
);
create table public.activity (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 hash text not null check (hash ~ '^0x[0-9a-fA-F]{64}$'),
 network text not null check (network in ('robinhood','ethereum','arbitrum','base')),
 address text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
 amount text not null check (amount ~ '^[0-9]+(\.[0-9]{1,18})?$'),
 created bigint not null default ((extract(epoch from now()) * 1000)::bigint)
);
create index activity_user_created on public.activity(user_id,created desc);

grant select,insert,update on public.profiles to authenticated;
grant all on public.profiles to service_role;
grant select,insert,delete on public.contacts to authenticated;
grant all on public.contacts to service_role;
grant select,insert on public.activity to authenticated;
grant all on public.activity to service_role;

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.activity enable row level security;

create policy "Read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own profile" on public.profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own profile" on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Read own contacts" on public.contacts for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own contacts" on public.contacts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Remove own contacts" on public.contacts for delete to authenticated using ((select auth.uid()) = user_id);
create policy "Read own activity" on public.activity for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own activity" on public.activity for insert to authenticated with check ((select auth.uid()) = user_id and network in ('robinhood','ethereum','arbitrum'));