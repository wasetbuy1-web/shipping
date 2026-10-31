-- Add an optional second product photo URL for the bag storefront.
alter table public.bag_catalog
  add column if not exists image_url_2 text;

comment on column public.bag_catalog.image_url_2 is
  'Optional second product photo URL for the storefront gallery.';
