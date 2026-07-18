/**
 * All shipping-layer configuration in one place: table names, health
 * states, retry tuning, storage keys, and feature flags. No business logic
 * lives here -- only values other modules read.
 *
 * Currency conversion (USD -> SAR) and weight-unit conversion (lb/kg) are
 * NOT here: they stay in index.html's lookupShipping()/getWeightLb(),
 * which already owned them before this refactor and are used well beyond
 * the shipping layer (product weights generally). Moving them here would
 * duplicate a constant this module never actually needs to consume.
 */

export const TABLES = Object.freeze({
  WAREHOUSES: 'warehouses',
  CARRIERS: 'carriers',
  SHIPPING_RATES: 'shipping_rates',
});

/** @type {Record<string,string>} */
export const HEALTH_STATE = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  OFFLINE: 'offline',
  RETRYING: 'retrying',
  FAILED: 'failed',
});

export const RETRY_CONFIG = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
});

export const OFFLINE_CACHE_STORAGE_KEY = 'shipping_offline_cache_v1';

/**
 * Default value for every feature flag. Toggling at runtime is done via
 * localStorage (see getFeatureFlag/setFeatureFlag below) -- these are only
 * the fallback when no override is stored.
 */
export const FEATURE_FLAG_DEFAULTS = Object.freeze({
  SUPABASE_SHIPPING: true, // master switch: fetch live rates from Supabase at all
  OFFLINE_CACHE: true, // fall back to last known-good cached rates when Supabase fails
  EMERGENCY_IMPORT: false, // allow the Developer-Mode-only manual import UI
  DEBUG_SHIPPING: false, // verbose console logging of the shipping layer's internal state
});

const FEATURE_FLAGS_STORAGE_KEY = 'shipping_feature_flags_v1';
const DEV_MODE_STORAGE_KEY = 'shipping_dev_mode';

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Reads the current value of a feature flag: a localStorage override if one
 * was set via setFeatureFlag(), otherwise the default above. Every flag is
 * toggleable at runtime without a code change or redeploy.
 */
export function getFeatureFlag(name, storage = window.localStorage) {
  const overrides = readJson(storage, FEATURE_FLAGS_STORAGE_KEY, {});
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return !!overrides[name];
  return !!FEATURE_FLAG_DEFAULTS[name];
}

export function setFeatureFlag(name, value, storage = window.localStorage) {
  const overrides = readJson(storage, FEATURE_FLAGS_STORAGE_KEY, {});
  overrides[name] = !!value;
  storage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(overrides));
}

/**
 * Developer Mode gates the Emergency Import UI. Off by default; enabled via
 * `?dev=1` in the URL (sticky, persisted to localStorage) or directly via
 * setDevMode(true) from the console. Normal users never see or set this.
 */
export function isDevModeEnabled(storage = window.localStorage, location = window.location) {
  try {
    if (new URLSearchParams(location.search).get('dev') === '1') {
      storage.setItem(DEV_MODE_STORAGE_KEY, '1');
      return true;
    }
  } catch {
    // location/URLSearchParams unavailable (non-browser test environment) -- fall through
  }
  return storage.getItem(DEV_MODE_STORAGE_KEY) === '1';
}

export function setDevMode(enabled, storage = window.localStorage) {
  if (enabled) storage.setItem(DEV_MODE_STORAGE_KEY, '1');
  else storage.removeItem(DEV_MODE_STORAGE_KEY);
}
