/**
 * Raw Supabase access for shipping data -- the ONLY module in this layer
 * that issues queries against warehouses/carriers/shipping_rates.
 *
 * Named ShippingGateway, not "ShippingRepository": the real Repository
 * Pattern implementation lives in the backend (see the Python scraper
 * project's shipping_repository.py). This is a thin frontend data-access
 * gateway with no caching, no retry, and no fallback -- those belong to
 * ShippingProvider (provider.js), the only consumer of this class.
 */
import { TABLES } from './constants.js';

export class ShippingGateway {
  /** @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient */
  constructor(supabaseClient) {
    this._db = supabaseClient;
  }

  /** @returns {Promise<{warehouses: import('./types.js').Warehouse[], carriers: import('./types.js').Carrier[]}>} */
  async fetchWarehousesAndCarriers() {
    const [warehousesRes, carriersRes] = await Promise.all([
      this._db.from(TABLES.WAREHOUSES).select('id, code, name'),
      this._db.from(TABLES.CARRIERS).select('id, code, name'),
    ]);
    if (warehousesRes.error) throw warehousesRes.error;
    if (carriersRes.error) throw carriersRes.error;
    return { warehouses: warehousesRes.data || [], carriers: carriersRes.data || [] };
  }

  /** @returns {Promise<Array<{weight:number, price:number, currency:string, delivery_days:string|null}>>} */
  async fetchRates(warehouseId, carrierId) {
    const { data, error } = await this._db
      .from(TABLES.SHIPPING_RATES)
      .select('weight, price, currency, delivery_days')
      .eq('warehouse_id', warehouseId)
      .eq('carrier_id', carrierId);
    if (error) throw error;
    return data || [];
  }
}
