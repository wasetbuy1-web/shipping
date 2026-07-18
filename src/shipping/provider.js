/**
 * ShippingProvider: the ONLY shipping-layer symbol any UI code may import
 * or reference. It composes every other module in this folder:
 *
 *   ShippingGateway (repository.js) -- raw Supabase reads
 *   OfflineCache     (cache.js)      -- durable last-known-good fallback
 *   CalculatorEngine (calculator.js) -- pure price/weight math
 *   ShippingHealthService (service.js) -- boot/retry state machine
 *
 * No UI component should ever import ShippingGateway, OfflineCache,
 * CalculatorEngine, or ShippingHealthService directly -- ShippingProvider
 * is the single data entry point (see src/shipping/index.js, which only
 * re-exports this class).
 */
import { FEATURE_FLAG_DEFAULTS, HEALTH_STATE, getFeatureFlag, isDevModeEnabled } from './constants.js';
import { ShippingGateway } from './repository.js';
import { OfflineCache } from './cache.js';
import { CalculatorEngine } from './calculator.js';
import { ShippingHealthService } from './service.js';
import { cacheKey } from './utils.js';

export class ShippingProvider {
  /** @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient */
  constructor(supabaseClient) {
    this._gateway = new ShippingGateway(supabaseClient);
    this._cache = new OfflineCache();
    this._health = new ShippingHealthService();

    /** @type {Map<string, import('./types.js').Warehouse>|null} */
    this._warehousesByCode = null;
    /** @type {Map<string, import('./types.js').Carrier>|null} */
    this._carriersByCode = null;
    /** @type {Map<string, import('./types.js').RateTable>} */
    this._rateTableCache = new Map();

    this._lastPairs = [];
  }

  // ------------------------------------------------------------------ //
  // Startup / Retry Strategy
  // ------------------------------------------------------------------ //

  /**
   * Runs the full startup sequence for a set of (warehouseCode, carrierCode)
   * pairs: Supabase -> retry x3 -> Offline Cache -> Ready/Offline/Failed.
   * Safe to call multiple times; each call re-runs the whole sequence.
   * @param {import('./types.js').CarrierPair[]} pairs
   */
  async boot(pairs) {
    this._lastPairs = pairs;
    this._debug('boot() starting for pairs', pairs);

    return this._health.run(
      () => this._loadAllLive(pairs),
      () => this._loadAllFromOfflineCache(pairs)
    );
  }

  /** Re-runs boot() for the same pairs used last time -- used by "retry" UI actions. */
  async retry(pairs = this._lastPairs) {
    return this.boot(pairs);
  }

  async _loadAllLive(pairs) {
    if (!getFeatureFlag('SUPABASE_SHIPPING')) {
      throw new Error('SUPABASE_SHIPPING feature flag is disabled');
    }
    await this._ensureMetadataLoaded();
    await Promise.all(pairs.map(([warehouseCode, carrierCode]) => this._loadOneLive(warehouseCode, carrierCode)));
  }

  async _loadOneLive(warehouseCode, carrierCode) {
    const key = cacheKey(warehouseCode, carrierCode);
    const warehouse = this._warehousesByCode.get(warehouseCode);
    const carrier = this._carriersByCode.get(carrierCode);
    if (!warehouse || !carrier) {
      throw new Error(`Unknown warehouse_code/carrier_code combination: ${key}`);
    }

    const rows = await this._gateway.fetchRates(warehouse.id, carrier.id);
    const table = {};
    rows.forEach((row) => {
      table[row.weight] = { price: row.price, currency: row.currency, deliveryDays: row.delivery_days || '' };
    });

    this._rateTableCache.set(key, table);
    this._cache.save(key, table); // keep the offline cache fresh on every successful live load
  }

  async _ensureMetadataLoaded() {
    if (this._warehousesByCode && this._carriersByCode) return;
    const { warehouses, carriers } = await this._gateway.fetchWarehousesAndCarriers();
    this._warehousesByCode = new Map(warehouses.map((w) => [w.code, w]));
    this._carriersByCode = new Map(carriers.map((c) => [c.code, c]));
  }

  _loadAllFromOfflineCache(pairs) {
    if (!getFeatureFlag('OFFLINE_CACHE')) return false;
    let recoveredAny = false;
    for (const [warehouseCode, carrierCode] of pairs) {
      const key = cacheKey(warehouseCode, carrierCode);
      const table = this._cache.load(key);
      if (table) {
        this._rateTableCache.set(key, table);
        recoveredAny = true;
      }
    }
    if (recoveredAny) this._debug('Recovered rate tables from offline cache');
    return recoveredAny;
  }

  // ------------------------------------------------------------------ //
  // Calculation (delegates to the pure CalculatorEngine)
  // ------------------------------------------------------------------ //

  /**
   * @param {string} warehouseCode
   * @param {string} carrierCode
   * @param {number} weightLb
   * @returns {import('./types.js').ShippingRate|null}
   */
  getRate(warehouseCode, carrierCode, weightLb) {
    const table = this._rateTableCache.get(cacheKey(warehouseCode, carrierCode)) || {};
    return CalculatorEngine.getRate(table, weightLb);
  }

  isReady(warehouseCode, carrierCode) {
    const table = this._rateTableCache.get(cacheKey(warehouseCode, carrierCode));
    return !!table && Object.keys(table).length > 0;
  }

  // ------------------------------------------------------------------ //
  // Health Check
  // ------------------------------------------------------------------ //

  getHealthState() {
    return this._health.getState();
  }

  onHealthStateChange(listener) {
    return this._health.onStateChange(listener);
  }

  isLoading() {
    return [HEALTH_STATE.LOADING, HEALTH_STATE.RETRYING].includes(this.getHealthState());
  }

  isOffline() {
    return this.getHealthState() === HEALTH_STATE.OFFLINE;
  }

  isFailed() {
    return this.getHealthState() === HEALTH_STATE.FAILED;
  }

  // ------------------------------------------------------------------ //
  // Feature Flags / Developer Mode
  // ------------------------------------------------------------------ //

  isDevModeEnabled() {
    return isDevModeEnabled();
  }

  isEmergencyImportEnabled() {
    return this.isDevModeEnabled() && getFeatureFlag('EMERGENCY_IMPORT');
  }

  isFeatureEnabled(flagName) {
    return getFeatureFlag(flagName);
  }

  // ------------------------------------------------------------------ //
  // Emergency Import (see legacy/excel_import.js -- loaded on demand only)
  // ------------------------------------------------------------------ //

  /**
   * Manually seeds a rate table for one (warehouseCode, carrierCode) pair,
   * bypassing Supabase entirely. Used only by the Developer-Mode Emergency
   * Import UI as a last resort when both live retries and the offline
   * cache have failed. Persists to the offline cache too, so the recovery
   * survives a reload.
   * @param {string} warehouseCode
   * @param {string} carrierCode
   * @param {import('./types.js').RateTable} table
   */
  importEmergencyTable(warehouseCode, carrierCode, table) {
    if (!this.isEmergencyImportEnabled()) {
      console.warn('ShippingProvider: importEmergencyTable ignored -- Emergency Import is disabled');
      return false;
    }
    const key = cacheKey(warehouseCode, carrierCode);
    this._rateTableCache.set(key, table);
    this._cache.save(key, table);
    console.warn(`ShippingProvider: emergency table imported for ${key}. This is NOT live Supabase data.`);
    return true;
  }

  _debug(...args) {
    if (getFeatureFlag('DEBUG_SHIPPING')) console.debug('[ShippingProvider]', ...args);
  }
}
