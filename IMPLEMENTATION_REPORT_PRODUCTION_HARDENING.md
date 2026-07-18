# Implementation Report: Production Hardening of the Shipping Layer (Phase 4)

**Date:** 2026-07-18
**Scope:** `موقع الشحن/` (website)

---

# Overview

Phase 3 gave the website a working `ShippingRepository`/`ShippingService`/`CalculatorEngine` stack, but all of it lived inline inside `index.html`, had no offline fallback, no health/retry visibility, and no recovery path if Supabase went down. Phase 4 hardens that stack for production without changing its external behavior: the same three layers now live in real ES modules under `src/shipping/`, backed by an Offline Cache, a Health Check state machine, a bounded Retry Strategy, Feature Flags, and a Developer-Mode-only Emergency Import — while `index.html` shrinks to a thin consumer of one object: `ShippingProvider`.

**Why it changed:** a production shipping layer that only works when Supabase is reachable and only reports "loading or not" is not production-ready. The task asked for resiliency (offline continuity), observability (health states), and a last-resort recovery path (emergency import) — all without touching the calculation logic itself or the external repository contract.

---

# Files Created

| File | Purpose |
|---|---|
| `src/shipping/index.js` | Barrel — re-exports **only** `ShippingProvider` |
| `src/shipping/provider.js` | `ShippingProvider` — the sole public facade |
| `src/shipping/repository.js` | `ShippingGateway` — raw Supabase reads (internal) |
| `src/shipping/service.js` | `ShippingHealthService` — boot/retry state machine (internal) |
| `src/shipping/calculator.js` | `CalculatorEngine` — pure rate math, relocated unchanged |
| `src/shipping/cache.js` | `OfflineCache` — localStorage-backed last-known-good rates |
| `src/shipping/constants.js` | Table names, health states, retry tuning, feature flags, dev-mode helpers |
| `src/shipping/types.js` | JSDoc typedefs for every boundary object |
| `src/shipping/utils.js` | `cacheKey`, `nearestAvailableWeight`, `withRetry` |
| `legacy/excel_import.js` | Deprecated, emergency-only Excel/CSV/JSON importer |
| `package.json` | `{"type":"module"}` so Node tooling resolves `src/shipping`/`legacy` as ES modules (browser ignores this file entirely) |

# Files Modified

| File | Change |
|---|---|
| `index.html` | Removed the inline `ShippingRepository`/`ShippingService`/`CalculatorEngine` IIFEs (~140 lines); added `window.db = db` so the new module script can reuse the existing client; added a `<script type="module">` that constructs `ShippingProvider` and calls `initApp()`; renamed every `ShippingService.*`/`CalculatorEngine.*` call site to `ShippingProvider.*`; added the hidden Emergency Import UI + its two file-input handlers; added a shipping health-state line to the settings modal |

---

# Legacy System

The original Excel/CSV rate importer (`findHeader`, `findFallback`, `parseRowsToRates`, `handleRateFile`, etc. — removed in Phase 3) was **recreated verbatim** as `legacy/excel_import.js`, plus a new JSON path (`parseJsonRateFile`) and a fan-out helper (`toRateTablesByCarrier`) that converts the old multi-carrier MyUS shape into the canonical per-carrier `RateTable` the new system uses.

It is loaded **only** via a dynamic `import('./legacy/excel_import.js')` inside the two Emergency Import handlers — there is no static `import` or `<script>` tag anywhere else referencing it. This means:
- It is never fetched over the network during normal page load.
- It has zero effect on page weight or startup time for normal users.
- It only ever executes if a Developer-Mode user, with the `EMERGENCY_IMPORT` flag on, actually selects a file in the (otherwise hidden) Emergency Import section.

The file's top comment marks it explicitly as `DEPRECATED -- EMERGENCY USE ONLY`.

---

# Shipping Provider

`ShippingProvider` (`provider.js`) is the **only** shipping symbol `index.html` imports (`src/shipping/index.js` re-exports nothing else) and the only one any UI code may call. It composes:
- `ShippingGateway` — live Supabase reads.
- `OfflineCache` — durable fallback.
- `CalculatorEngine` — pure math (unchanged from Phase 3).
- `ShippingHealthService` — boot/retry sequencing.

Public surface: `boot(pairs)`, `retry(pairs)`, `getRate(warehouseCode, carrierCode, weightLb)`, `isReady(...)`, `getHealthState()`, `isLoading()/isOffline()/isFailed()`, `isDevModeEnabled()`, `isEmergencyImportEnabled()`, `isFeatureEnabled(flag)`, `importEmergencyTable(...)`.

The name change from `ShippingRepository`/`ShippingService` to `ShippingProvider` is deliberate: the real Repository Pattern implementation lives in the backend (`shipping_repository.py` in the scraper project, untouched by this phase). The frontend object only *consumes* data — it has no write path to `shipping_rates`, no persistence responsibility beyond its own cache. Calling it a "Repository" overstated what it does.

---

# Offline Cache

`OfflineCache` (`cache.js`) persists every successfully-fetched rate table to `localStorage`, keyed by `${warehouseCode}::${carrierCode}`, with a timestamp. It is written to on **every** successful live fetch (`ShippingProvider._loadOneLive`), so it is always "last known good," not a one-time snapshot.

When live fetching fails after every retry, `ShippingProvider` calls `_loadAllFromOfflineCache()`, which loads whatever it has into the in-memory rate cache and returns whether it recovered anything. If it did, the health state becomes `OFFLINE` (not `READY`) — calculations continue using the stale-but-usable data, and the UI is expected to show an offline indicator (see **Health Check**).

Verified in testing: a provider that never successfully booted, given a Supabase failure, has nothing to recover and correctly ends in `FAILED`; a provider that inherits a warm `OfflineCache` from an earlier successful session correctly recovers into `OFFLINE` with the exact last-good price.

---

# Health Check

Startup sequence (`ShippingProvider.boot()` → `ShippingHealthService.run()`):

```
LOADING
  │  attempt live fetch (all pairs, in parallel)
  ▼
success? ──yes──▶ READY
  │no
  ▼
RETRYING (up to 3 attempts, linear backoff)
  │  all attempts exhausted
  ▼
offline cache has data? ──yes──▶ OFFLINE
  │no
  ▼
FAILED
```

`getHealthState()` returns one of `loading | ready | offline | retrying | failed` at any time; `onHealthStateChange(listener)` lets any future UI subscribe to transitions instead of polling. The current state is surfaced in the settings modal (`renderRateFileStatus()` now also writes a human-readable Arabic label for the current state) and drives the existing "please wait / retry" banners from Phase 3 (now further distinguishing loading from a genuine failure).

---

# Retry Strategy

Implemented once, generically, in `utils.withRetry()` and driven by `ShippingHealthService.run()`: up to `RETRY_CONFIG.MAX_ATTEMPTS` (3) attempts with linearly increasing backoff (`BASE_DELAY_MS * attempt`), emitting `RETRYING` between attempts. On exhaustion, control passes to the Offline Cache fallback, and only if that also has nothing does the state become `FAILED`. `ShippingProvider.retry(pairs)` re-runs the exact same sequence — this is what the existing "🔄 إعادة تحميل الأسعار" button and the top banner already call. No branch of this ever throws out of `boot()`/`retry()`; every path resolves to a terminal state.

---

# Emergency Import

Two independent paths, both Developer-Mode-gated:
1. **Legacy Excel/CSV** — picks a provider type (MyUS or Shop & Ship) from a dropdown, parses the file with the recreated legacy column-detection logic, and fans the result out into one `RateTable` per matching carrier (all four MyUS carriers at once, exactly like the original multi-column file format).
2. **JSON** — picks one specific carrier from a dropdown (built from the live `CARRIERS` array) and expects a direct `{weight: {price, currency, deliveryDays}}` file — the fastest possible manual recovery path.

Both call `ShippingProvider.importEmergencyTable(warehouseCode, carrierCode, table)`, which:
- Refuses (logs a warning, returns `false`) unless **both** Developer Mode and the `EMERGENCY_IMPORT` flag are on — enforced a second time at the provider level, not just in the UI, so it can't be triggered by console access alone without the flag.
- Writes directly into the same in-memory cache `getRate()` reads from, so calculations resume immediately.
- Persists into `OfflineCache` too, so the recovery survives a reload.

Verified in testing: a fresh provider with zero data, after a full failure, correctly returns `null` from `getRate()`; after `importEmergencyTable()`, the exact same call returns the imported price immediately — including through the real DOM `change` event → `handleEmergencyImportJsonFile()` → dynamic `import()` path, not just the provider API directly.

---

# Feature Flags

| Flag | Default | Effect when off |
|---|---|---|
| `SUPABASE_SHIPPING` | on | Skips live Supabase fetch entirely — boot proceeds straight to the offline-cache/failed branch, as if every live attempt failed instantly |
| `OFFLINE_CACHE` | on | Disables the offline fallback — a live-fetch failure goes straight to `FAILED` even if cached data exists |
| `EMERGENCY_IMPORT` | off | Emergency Import UI stays hidden and `importEmergencyTable()` refuses, even with Developer Mode on |
| `DEBUG_SHIPPING` | off | Enables verbose `console.debug` logging from `ShippingProvider` |

Every flag is read via `getFeatureFlag(name)` (`constants.js`), which checks a `localStorage` override first and falls back to the default above — toggle any of them at runtime via `setFeatureFlag(name, true|false)` from the console, no redeploy needed. Developer Mode itself follows the same pattern (`?dev=1` in the URL sets a sticky `localStorage` flag; `setDevMode(true)` from the console does the same) and is `false` by default.

---

# Architecture

**Old (Phase 3):**
```
index.html
  ├─ CARRIERS, lookupShipping(), render functions      (business logic)
  └─ <script> ShippingRepository/ShippingService/CalculatorEngine (business logic, inline)
```

**New (Phase 4):**
```
index.html                              <- consumer only
  ├─ CARRIERS (data), lookupShipping()/isMyusUploaded() (thin delegation)
  ├─ Emergency Import UI (hidden, Developer Mode only)
  └─ <script type="module"> constructs window.ShippingProvider, calls initApp()
         │
         ▼
src/shipping/index.js  ──exports only──▶  ShippingProvider (provider.js)
                                              │  composes
                    ┌─────────────────┬───────┴────────┬─────────────────┐
                    ▼                 ▼                ▼                 ▼
          ShippingGateway      OfflineCache     CalculatorEngine   ShippingHealthService
          (repository.js)      (cache.js)       (calculator.js)    (service.js)
             │                    │                  (pure)             │
             ▼                    ▼                                     ▼
          Supabase            localStorage                    retry/state machine

legacy/excel_import.js  <-- dynamic import() only, Developer Mode + EMERGENCY_IMPORT flag
```

No UI code imports anything below `ShippingProvider` in that diagram. `index.html`'s business logic responsibility is reduced to: carrier metadata (`CARRIERS`), unit conversion (`getWeightLb`, pre-existing, used site-wide beyond shipping), and thin delegating wrappers.

---

# Performance

- Identical to Phase 3 for the success path: each `(warehouseCode, carrierCode)` pair is still fetched at most once per boot, in parallel.
- Offline Cache writes happen only on the already-in-flight successful fetch path (no extra request), and reads are synchronous `localStorage` lookups.
- `withRetry`'s backoff only engages on actual failures — the common case (Supabase reachable) has zero added latency versus Phase 3.
- Splitting one big inline script into ~9 small ES modules adds one extra network round-trip class (browser HTTP/2 multiplexes them over the existing connection to the same origin) at first load; this is the standard, accepted cost of modularizing a previously-monolithic script, and is dwarfed by the Supabase round-trips already on the critical path.

---

# Security

- The Emergency Import path is defense-in-depth gated: hidden in the DOM by default, gated by a `localStorage`-backed Developer Mode flag, gated *again* inside `ShippingProvider.importEmergencyTable()` itself (so it can't be invoked by calling the method directly from the console without also flipping the feature flag), and it never touches Supabase or any write endpoint — it only ever writes to the browser's own `localStorage` and in-memory cache.
- No new credentials or endpoints were introduced. `src/shipping/repository.js` uses the exact same Supabase anon client (`window.db`) already in use, with the same read-only grants documented in the Phase 3 report.
- `legacy/excel_import.js` parses user-provided files entirely client-side (as it always did) — no file is ever uploaded anywhere.

---

# Future Expansion

- Adding a new provider still requires only a `CARRIERS` entry (Phase 3's model is unchanged) — `SHIPPING_PAIRS_TO_PRELOAD` is still derived from it automatically.
- `ShippingHealthService.onStateChange()` is ready for a future visible health indicator (e.g., a small persistent badge) without any change to `ShippingProvider`'s public contract.
- The Feature Flag mechanism (`getFeatureFlag`/`setFeatureFlag`) is generic — a future flag needs only a new key in `FEATURE_FLAG_DEFAULTS`, no new plumbing.
- `legacy/excel_import.js`'s JSON path is the natural seed for a future "export current Supabase rates to JSON" admin tool, if a faster manual snapshot/restore cycle is ever needed.

---

# Summary

The shipping layer's external behavior is unchanged — verified end-to-end (identical calculated prices, currency conversion, weight capping, FedEx-Priority mapping) against the real `index.html` using a scripted jsdom + Node `vm` integration test that executes the actual classic `<script>` blocks and constructs the actual `ShippingProvider` class, including a full dynamic-`import()`-driven Emergency Import round trip. What changed underneath: business logic moved out of `index.html` into nine focused ES modules under `src/shipping/`; the frontend's Supabase-facing class was renamed from `ShippingRepository`/`ShippingService` to `ShippingProvider` to reflect that it consumes data rather than owning it; a durable Offline Cache, a five-state Health Check, a bounded Retry Strategy, four toggleable Feature Flags, and a hidden, doubly-gated Emergency Import path were added on top. Two genuine issues were found and fixed during the final review before this was considered done: duplicated try/catch/status/toast scaffolding across the two Emergency Import handlers (consolidated into `runEmergencyImport()`), and three dead exports (`toLb`, `USD_TO_SAR`, `KG_TO_LB` in the new module tree) that were written speculatively but never wired to anything.
