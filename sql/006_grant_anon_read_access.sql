-- Fixes: "permission denied for table shipping_rates" (42501), confirmed live
-- on 2026-07-17 by querying the project directly with the website's real
-- anon/publishable key. The `anon` role currently has no SELECT grant at all
-- on warehouses/carriers/shipping_rates, so the new ShippingRepository in
-- index.html would fail on every request once deployed.
--
-- This is read-only (SELECT only) -- the website never writes shipping data,
-- only the Python scrapers (via the service_role key) do.
--
-- Also requires sql/003 and sql/004 from the scraper project's migrations
-- (اسعار الشحن المحدثة/sql/) to have been run first, since this website
-- reads the same `code` columns those migrations add.
--
-- Run this once in the Supabase SQL editor.

grant select on public.warehouses to anon;
grant select on public.carriers to anon;
grant select on public.shipping_rates to anon;
