/**
 * ShippingHealthService: the startup/retry state machine.
 *
 * Internal collaborator used only by ShippingProvider -- it is NOT exported
 * from src/shipping/index.js and no UI code should import it directly.
 * Its only job is sequencing: Loading -> (Retrying)* -> Ready | Offline | Failed,
 * and notifying subscribers as the state changes. It has no idea what
 * "shipping rates" even are; ShippingProvider hands it plain callbacks.
 */
import { HEALTH_STATE, RETRY_CONFIG } from './constants.js';
import { withRetry } from './utils.js';

export class ShippingHealthService {
  constructor() {
    this._state = HEALTH_STATE.LOADING;
    this._listeners = new Set();
  }

  getState() {
    return this._state;
  }

  onStateChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this._listeners) listener(state);
  }

  /**
   * Runs the full startup/retry sequence:
   *   1. LOADING, attempt liveFetch()
   *   2. on failure: RETRYING, retry up to RETRY_CONFIG.MAX_ATTEMPTS
   *   3. all retries exhausted:
   *        - if offlineFallback() succeeds -> OFFLINE (stale-but-usable data)
   *        - otherwise -> FAILED (no data at all; caller may offer Emergency Import)
   * Never throws -- every branch resolves to a terminal state.
   *
   * @param {() => Promise<void>} liveFetch - fetch fresh data; throws on failure
   * @param {() => boolean} offlineFallback - load from offline cache; returns whether it found anything
   * @returns {Promise<import('./types.js').HealthState>}
   */
  async run(liveFetch, offlineFallback) {
    this._setState(HEALTH_STATE.LOADING);

    try {
      await withRetry(liveFetch, {
        maxAttempts: RETRY_CONFIG.MAX_ATTEMPTS,
        baseDelayMs: RETRY_CONFIG.BASE_DELAY_MS,
        onAttemptFailed: (attempt, err) => {
          console.warn(`ShippingHealthService: live fetch attempt ${attempt} failed`, err);
          if (attempt < RETRY_CONFIG.MAX_ATTEMPTS) this._setState(HEALTH_STATE.RETRYING);
        },
      });
      this._setState(HEALTH_STATE.READY);
      return this._state;
    } catch (err) {
      console.error('ShippingHealthService: all live-fetch retries exhausted', err);
    }

    let recoveredOffline = false;
    try {
      recoveredOffline = !!offlineFallback();
    } catch (err) {
      console.error('ShippingHealthService: offline fallback threw', err);
    }

    this._setState(recoveredOffline ? HEALTH_STATE.OFFLINE : HEALTH_STATE.FAILED);
    return this._state;
  }
}
