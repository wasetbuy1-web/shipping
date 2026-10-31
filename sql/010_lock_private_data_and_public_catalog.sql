-- Security hardening for the shipping calculator and public bag storefront.
-- Run once in Supabase SQL Editor. Then create an Auth user for the owner and
-- add that user's UUID to app_private.site_admin_users (instructions below).
-- Hermes should use its own Supabase Auth user, allowlisted only for
-- bag_catalog. Do not give Hermes a secret/service_role API key.

begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists app_private.site_admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all on table app_private.site_admin_users from public, anon, authenticated;

create table if not exists app_private.bag_catalog_importers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all on table app_private.bag_catalog_importers from public, anon, authenticated;

create or replace function public.is_current_user_site_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from app_private.site_admin_users as admins
    where admins.user_id = auth.uid()
  );
$$;
revoke all on function public.is_current_user_site_admin() from public, anon;
grant execute on function public.is_current_user_site_admin() to authenticated;

create or replace function public.is_bag_catalog_importer()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from app_private.bag_catalog_importers as importers
    where importers.user_id = auth.uid()
  );
$$;
revoke all on function public.is_bag_catalog_importer() from public, anon;
grant execute on function public.is_bag_catalog_importer() to authenticated;

-- Remove earlier permissive policies before installing the allowlist rules.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('orders', 'product_weights', 'bag_catalog')
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end;
$$;

alter table public.orders enable row level security;
alter table public.product_weights enable row level security;
alter table public.bag_catalog enable row level security;

revoke all on table public.orders from public, anon, authenticated;
grant select, insert, update, delete on table public.orders to authenticated;
create policy orders_owner_only on public.orders
  for all to authenticated
  using ((select public.is_current_user_site_admin()))
  with check ((select public.is_current_user_site_admin()));

revoke all on table public.product_weights from public, anon, authenticated;
grant select, insert, update, delete on table public.product_weights to authenticated;
create policy product_weights_owner_only on public.product_weights
  for all to authenticated
  using ((select public.is_current_user_site_admin()))
  with check ((select public.is_current_user_site_admin()));

revoke all on table public.bag_catalog from public, anon, authenticated;
grant select on table public.bag_catalog to anon;
grant select, insert, update, delete on table public.bag_catalog to authenticated;
create policy published_bag_catalog_is_public on public.bag_catalog
  for select to anon
  using (is_published is true);
create policy bag_catalog_importer_manage on public.bag_catalog
  for all to authenticated
  using ((select public.is_bag_catalog_importer()))
  with check ((select public.is_bag_catalog_importer()));

commit;

-- After creating your owner account in Supabase > Authentication > Users,
-- run this separately, replacing the UUID with that user's ID:
-- insert into app_private.site_admin_users (user_id)
-- values ('00000000-0000-0000-0000-000000000000');
--
-- Create a second, dedicated Auth user for Hermes and add its UUID here.
-- Keep that user's password in Hermes' private environment/secrets only:
-- insert into app_private.bag_catalog_importers (user_id)
-- values ('00000000-0000-0000-0000-000000000000');
