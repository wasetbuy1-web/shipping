-- Feature: Save Product Weight, matched by BOTH product URL and product
-- name (see findSavedWeightMatch() in index.html). Replaces the previous
-- localStorage-only saved-weights store (name-only matching) so weight
-- history is shared across browsers/devices instead of being per-browser.
--
-- Only three fields are ever written by the app: product_url, product_name,
-- weight_lb. id/timestamps are bookkeeping, not extra business data.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.product_weights (
  id uuid primary key default gen_random_uuid(),
  product_url text not null,
  product_name text not null,
  weight_lb numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The website (anon/publishable key) reads, creates, updates, and deletes
-- its own saved-weight rows directly -- mirrors the existing `orders` table
-- access pattern, not the read-only shipping_rates grant in sql/006.
grant select, insert, update, delete on public.product_weights to anon;
