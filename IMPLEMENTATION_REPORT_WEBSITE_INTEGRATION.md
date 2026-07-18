# Implementation Report: Website Integration with Supabase Shipping (Phase 3)

**Date:** 2026-07-17
**Scope:** `موقع الشحن/index.html` (single-file website)

---

# Overview

The website (a single `index.html`) already used Supabase for orders, but shipping prices were driven entirely by Excel/CSV files the user manually uploaded and parsed client-side into `localStorage` (`state.rateTables`). This phase removes that path completely and makes `shipping_rates` in Supabase the only source of truth for shipping calculations, via a new three-layer client-side architecture (Repository → Service → Calculator Engine) that mirrors the Python repository built in Phases 1–2.

**Why it changed:** the scrapers now write every real price into Supabase; keeping a parallel Excel-upload path on the website would mean two sources of truth that could silently disagree. The task requires exactly one.

---

# Files

### Created
None (single-file website; all changes are inside the existing `index.html`).

### Modified
| File | Change |
|---|---|
| `موقع الشحن/index.html` | Added Shipping Repository/Service/Calculator Engine; removed Excel rate-upload UI and parsing; rewired `lookupShipping`/`isMyusUploaded`/`isShopshipUploaded` to the new engine; updated all "please upload" UI copy to reflect DB-loading/retry semantics |

### Deleted (functions removed from index.html, no files deleted)
`mergeMyusRates`, `mergeShopshipRates`, `availableLb` (old table-shape version), `findHeader`, `findFallback`, `fileWeightToLb`, `parseRowsToRates`, `handleRateFile`, `headerHas`, the two rate-file `<input>` upload widgets, and the "حذف ملفات الشحن المرفوعة" (clear uploaded files) button — all superseded by Supabase-backed equivalents.

### Renamed
None. `isMyusUploaded()`/`isShopshipUploaded()`/`lookupShipping()`/`renderRateFileStatus()` keep their historical names (see **Design Decisions**) even though their meaning shifted from "file uploaded" to "Supabase data cached."

---

# Data Flow

```
UI (render functions, event handlers)
   │  calls lookupShipping(weight, unit, carrierId)   <- only entry point
   ▼
CalculatorEngine.getRate(warehouseCode, carrierCode, weightLb)
   │  pure, synchronous, reads an already-loaded cache
   ▼
ShippingService.getCachedRateTable(warehouseCode, carrierCode)
   │  cache populated once via ShippingService.preload() at app boot
   ▼
ShippingRepository.fetchWarehousesAndCarriers() / fetchRates()
   │  the only functions that call `db.from(...)`
   ▼
Supabase (warehouses, carriers, shipping_rates)
```

The UI never touches `db` for shipping data — only `ShippingRepository` does, and only `ShippingService` is allowed to call `ShippingRepository`. `CalculatorEngine` is the only thing every render function calls.

---

# Architecture Changes

**Old:**
```
User uploads .xlsx -> parseRowsToRates() -> state.rateTables (localStorage)
                                                    │
render functions -> lookupShipping() -> mergeMyusRates()/mergeShopshipRates() -> availableLb()
```
One flat blob of state, parsed and read entirely in the UI layer. No repository, no service, no separation between "get data" and "calculate."

**New:**
```
App boot -> ShippingService.preload(pairs) -> ShippingRepository -> Supabase
                                                    │ (cached in memory)
render functions -> lookupShipping() -> CalculatorEngine.getRate() -> ShippingService cache
```
Three layers, each with one job, matching the Repository Pattern already used for orders in this same file and the Python `ShippingRepository` from Phases 1–2.

**Improvements:**
1. **Shipping Service** (`ShippingService`) — resolves `warehouse_code`/`carrier_code` once, caches every rate table in memory, exposes `isReady()`/`isLoading()`/`reload()`.
2. **Caching** — every `(warehouseCode, carrierCode)` pair is fetched at most once per page load (`Map`-backed cache keyed by `"${warehouseCode}::${carrierCode}"`); `preload()` memoizes its own promise so concurrent callers never trigger duplicate requests.
3. **Calculator Engine** (`CalculatorEngine.getRate(warehouseCode, carrierCode, weight)`) — returns exactly `{price, currency, deliveryDays, lb, capped}`, the shape the task specifies (`lb`/`capped` are additive, preserved from the old return shape for backward compatibility with existing render code).
4. **Single call path** — `lookupShipping()` is the only function in the file that calls `CalculatorEngine`, and every carrier-pricing render path (`carrierOptionsForProduct`, `getCombinedMyusShipping`, `getProductSummary`) already went exclusively through `lookupShipping()` before this change, so no other call site needed touching.
5. **Removed duplication** — a per-carrier `warehouseCode`/`carrierCode` map was folded directly into the existing `CARRIERS` array (one source of truth for carrier metadata) instead of adding a second parallel lookup table.

---

# Design Decisions

**1. `CalculatorEngine.getRate()` is synchronous; the network call happens once, at boot.**
Supabase queries are inherently async, but every existing render function in this file (`lookupShipping`, `carrierOptionsForProduct`, `getCombinedMyusShipping`, …) calls shipping lookups synchronously, mid-render, dozens of times per keystroke. Converting all of that to async would mean rewriting the entire rendering pipeline — far beyond "integrate the website with Supabase" and a direct violation of "preserve current behaviour and UI." Instead, `ShippingService.preload()` is awaited once in `initApp()` (alongside the existing `loadOrders()` call), after which every calculation reads from an in-memory cache — functionally identical to how the old code could only calculate after a file was uploaded into `state.rateTables`, except the data now arrives from Supabase automatically instead of requiring a manual upload.

**2. `isMyusUploaded()`/`isShopshipUploaded()`/`lookupShipping()` keep their old names.**
These names appear at 15+ call sites across renders, banners, and gating logic. Renaming them for clarity would touch every one of those sites for a purely cosmetic gain, in a 7,400-line file with no test suite. Their *implementation* changed completely (from reading `state.rateTables` to reading `ShippingService`'s cache); their *names* did not, to keep the diff minimal and auditable. This is called out explicitly in code comments at each definition.

**3. The site's single "FedEx" carrier maps to `FEDEX_PRIORITY`, not `FEDEX_ECONOMY`.**
The DB has both `FEDEX_ECONOMY` and `FEDEX_PRIORITY` (added in Phase 2), but this website has only ever had one FedEx option. Evidence from the site's own (now-removed) Excel-header importer settled this without guessing: its column-alias list accepted `'fedex priority'` as a synonym for the FedEx column and never mentioned `'fedex economy'`. Documented directly above the `CARRIERS` array.

**4. Currency conversion is now currency-driven, not source-driven.**
The old code always multiplied MyUS prices by `USD_TO_SAR` and used Shop & Ship prices as-is, hardcoding the assumption "MyUS = USD, Shop & Ship = SAR" into the code path itself. `lookupShipping()` now checks `rate.currency === 'USD'` (the value Supabase returns per row) before converting — behaviorally identical today (MyUS rows are USD, Shop & Ship rows are SAR), but correct automatically if that ever changes, and no longer a hardcoded per-provider assumption.

**5. Delivery days now come from the database, with the old hardcoded string as a fallback.**
Each `CARRIERS` entry always had a static `time` string (e.g. `'3 - 6 أيام'`). `shipping_rates.delivery_days` (scraped per weight, per carrier) is now preferred when present (`s.deliveryDays || carrier.time`), which is more accurate than a single constant per carrier, while the fallback guarantees no blank ever shows if a specific weight's row happens to have no delivery estimate.

**6. The "please upload Excel" alerts became "loading / failed to load, tap to retry" alerts.**
Removing Excel upload removes the very concept those alerts were built around. All four occurrences of this alert block were updated to distinguish `ShippingService.isLoading()` (still fetching — friendly, non-actionable) from a genuine failure (shows a retry button calling the new `retryLoadShippingRates()`, which clears the cache and re-preloads). The visual component (`.filesAlert` card) and its CSS were kept as-is; only the copy and the button's action changed.

**7. Structural HTML duplication across the four alert blocks was not refactored.**
That duplication predates this change. Consolidating it into a shared template helper would be a legitimate cleanup, but it touches more render code than this task requires and adds regression risk in an untested file; left as a disclosed opportunity rather than done speculatively.

---

# Performance

- Every `(warehouseCode, carrierCode)` pair is fetched **at most once per page load**, in parallel (`Promise.all` in `preload()`), rather than once per calculation.
- `preload()` memoizes its own promise (`loadPromise`), so if multiple things trigger a load before it resolves, only one set of network requests is made.
- `ShippingRepository.fetchWarehousesAndCarriers()` loads both tables in parallel and is itself only called once (cached by `ShippingService` via `warehousesByCode`/`carriersByCode`, populated lazily and reused across every subsequent `loadRateTable()` call).
- No change to render-time performance: `CalculatorEngine.getRate()` is a synchronous `Map`/array lookup over already-fetched data, same cost profile as the old `availableLb()` over `state.rateTables`.

---

# Validation

This change was validated by extracting both inline `<script>` blocks from the actual `index.html` and running them against a `jsdom`-rendered copy of the real page (styles stripped; DOM and business logic intact) with a mock Supabase client seeded with the project's real warehouse/carrier ids and codes:

- **Correctness**: `lookupShipping(5, 'lb', 'budget')` → `157.875` SAR (`42.10` USD × `3.75`); `lookupShipping(5, 'lb', 'fedex')` → `331.875` SAR (`88.50` USD, confirming the FedEx→Priority mapping is wired correctly end-to-end); `lookupShipping(5, 'lb', 'shopship')` → `45` SAR passed through unconverted.
- **Weight capping**: requesting weight `999` against a table whose only tier is `5` correctly returns `capped: true, lb: 5` — the "round up to next available tier, or cap at the highest" behavior is unchanged from the old `availableLb()`.
- **Graceful failure**: simulating a Supabase error on every table makes `lookupShipping()` return `{price: 0, ...}` (never throws), `isMyusUploaded()`/`isShopshipUploaded()` correctly flip to `false`, and no uncaught exception reaches `window.onerror`.
- **Recovery**: calling `retryLoadShippingRates()` after a simulated failure, then again after the simulated failure is cleared, restores correct pricing (`157.875` again) with no stale cache left over.
- Both extracted script blocks were separately re-validated with `node --check` after every edit for plain syntax correctness.

**A real, deployment-blocking issue was found and fixed during this validation.** After finishing the code, the website's actual `anon`/publishable key was tested directly against the live Supabase project (read-only `GET` requests — exactly what the deployed page does):
```
GET /rest/v1/shipping_rates -> 42501 permission denied for table shipping_rates
hint: GRANT SELECT ON public.shipping_rates TO anon;
```
The `anon` role had no `SELECT` grant at all on `warehouses`, `carriers`, or `shipping_rates` — the same class of missing-GRANT issue Phase 1 found for the `service_role` key, this time on the read side. Without this, the website would deploy successfully, run with no console errors, and simply show "تعذر تحميل أسعار الشحن" (failed to load) forever. Fixed via `sql/006_grant_anon_read_access.sql` (new). **This must be run in the Supabase SQL editor before the site goes live**, alongside `sql/003`/`sql/004` from the scraper project (which add and populate the `code` columns this website's queries depend on — also confirmed still pending, since querying `warehouses.code` live currently returns `column warehouses.code does not exist`).

---

# Future Work

- **New providers** (Stackry, Planet Express, FishisFast, Forward2Me, …): once their scraper/normalizer exist per the Phase 2 architecture and their `warehouse_code`/`carrier_code` rows exist in Supabase, adding them to the website is a single change — add one entry to the `CARRIERS` array with its `warehouseCode`/`carrierCode`. `SHIPPING_PAIRS_TO_PRELOAD` is derived from `CARRIERS` automatically, so the new provider is preloaded and calculable with no other code touched.
- **Consolidating the four "please upload/retry" alert blocks** into one shared render helper (noted above as a disclosed, not-yet-done cleanup).
- **A real loading skeleton** instead of the "no data" alert during the (typically sub-second) window before `ShippingService.preload()` resolves, if that window ever becomes noticeable on slow connections.
- **TTL/refresh** for the in-memory cache if the site is ever left open across a scraper re-run — today the cache is per-page-load only (a reload always re-fetches current prices), which matches the old "re-upload the file to update prices" behavior.

---

# Summary

Excel is fully removed from the shipping-price path: no upload inputs, no client-side parsing, no `localStorage`-persisted rate tables remain (the unrelated "Saved Weights" backup feature, which also uses the XLSX library, was intentionally left untouched — it has nothing to do with shipping prices). A new three-layer client-side architecture (`ShippingRepository` → `ShippingService` → `CalculatorEngine`) now backs every shipping calculation on the site, mirroring the Repository Pattern already used for orders and the Python repository from Phases 1–2. `shipping_repository.py` (the Python/Supabase repository) was not opened or modified in this phase — only the website's own, new, additive JS layer was added. The refactor was validated end-to-end (success, currency conversion, weight capping, failure, and retry/recovery) against the live HTML file using a scripted jsdom test before being considered complete.
