/**
 * Pure shipping-rate calculator. Same lookup semantics as the original
 * inline CalculatorEngine from the Supabase-integration phase: round up to
 * the next available weight tier, or cap at the highest tier if the
 * requested weight exceeds every tier. This logic is unchanged -- only its
 * location moved out of index.html.
 *
 * Pure by design: no Supabase, no cache, no network, no DOM. It operates
 * only on a plain rate table object handed to it by ShippingProvider.
 */
import { nearestAvailableWeight } from './utils.js';

export const CalculatorEngine = Object.freeze({
  /**
   * @param {import('./types.js').RateTable} table
   * @param {number} weightLb
   * @returns {import('./types.js').ShippingRate|null}
   */
  getRate(table, weightLb) {
    if (!(weightLb > 0)) return null;
    const lb = Math.ceil(weightLb);
    const match = nearestAvailableWeight(table, lb);
    if (!match) return null;
    const row = table[match.weight];
    if (!row) return null;
    return {
      price: row.price,
      currency: row.currency,
      deliveryDays: row.deliveryDays,
      lb: match.weight,
      capped: match.capped,
    };
  },
});
