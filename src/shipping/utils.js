/**
 * Small, pure helpers shared across the shipping layer. Nothing here talks
 * to Supabase, localStorage, or the DOM.
 *
 * Weight-unit conversion (lb/kg) is deliberately NOT here: it already
 * exists in index.html as getWeightLb()/getWeightKg(), used across the
 * whole product/order system, not just shipping. lookupShipping() converts
 * to lb before calling ShippingProvider.getRate(), which only ever
 * receives an already-normalized lb value.
 */

export function cacheKey(warehouseCode, carrierCode) {
  return `${warehouseCode}::${carrierCode}`;
}

/**
 * Given a rate table (weight -> row) and a desired weight, finds the
 * cheapest-fitting tier: the smallest available weight >= desired, or the
 * highest available tier if the desired weight exceeds every tier
 * (marked `capped`). Returns null if the table is empty.
 */
export function nearestAvailableWeight(table, desiredWeight) {
  const keys = Object.keys(table)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!keys.length) return null;
  const next = keys.find((k) => k >= desiredWeight);
  const chosen = next ?? keys[keys.length - 1];
  return { weight: chosen, capped: desiredWeight > keys[keys.length - 1] };
}

/**
 * Retries an async operation up to maxAttempts times with linear backoff.
 * Calls onAttemptFailed(attempt, error) between attempts (useful for
 * driving a "retrying" UI state). Re-throws the last error if every
 * attempt fails -- callers decide what "never crash" means for them.
 */
export async function withRetry(operation, { maxAttempts, baseDelayMs, onAttemptFailed } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      onAttemptFailed?.(attempt, err);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
    }
  }
  throw lastError;
}
