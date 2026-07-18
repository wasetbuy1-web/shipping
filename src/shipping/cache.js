/**
 * Offline Cache: persists the last known-good rate table for every
 * (warehouseCode, carrierCode) pair to localStorage, so calculations can
 * continue across page reloads even if Supabase is unreachable.
 *
 * This is distinct from ShippingProvider's in-memory cache: the in-memory
 * cache is lost on reload and exists purely to avoid duplicate network
 * requests within one page session. OfflineCache is the durable fallback
 * the Retry Strategy falls back to once live retries are exhausted.
 */
import { OFFLINE_CACHE_STORAGE_KEY } from './constants.js';

export class OfflineCache {
  constructor(storage = window.localStorage, storageKey = OFFLINE_CACHE_STORAGE_KEY) {
    this._storage = storage;
    this._key = storageKey;
  }

  _readAll() {
    try {
      const raw = this._storage.getItem(this._key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _writeAll(data) {
    try {
      this._storage.setItem(this._key, JSON.stringify(data));
    } catch (err) {
      console.warn('OfflineCache: failed to persist to localStorage', err);
    }
  }

  /** @param {string} key @param {import('./types.js').RateTable} table */
  save(key, table) {
    const all = this._readAll();
    all[key] = { table, savedAt: new Date().toISOString() };
    this._writeAll(all);
  }

  /** @param {string} key @returns {import('./types.js').RateTable|null} */
  load(key) {
    return this._readAll()[key]?.table || null;
  }

  getSavedAt(key) {
    return this._readAll()[key]?.savedAt || null;
  }

  has(key) {
    return !!this._readAll()[key];
  }

  hasAny() {
    return Object.keys(this._readAll()).length > 0;
  }

  clear() {
    this._writeAll({});
  }
}
