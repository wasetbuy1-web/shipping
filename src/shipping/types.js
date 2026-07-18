/**
 * JSDoc-only type definitions for the shipping layer. No runtime code --
 * this file exists purely so editors/IDEs can type-check callers, and so
 * the shape of every boundary object is documented in one place.
 */

/**
 * @typedef {Object} RateTableRow
 * @property {number} price
 * @property {string} currency
 * @property {string} deliveryDays
 */

/**
 * @typedef {Object.<string, RateTableRow>} RateTable
 * Keyed by weight (as it comes back from JSON, weight keys are strings).
 */

/**
 * @typedef {Object} ShippingRate
 * @property {number} price
 * @property {string} currency
 * @property {string} deliveryDays
 * @property {number} lb - the weight tier actually matched (>= requested weight, or the highest available)
 * @property {boolean} capped - true if the requested weight exceeded every available tier
 */

/**
 * @typedef {Object} Warehouse
 * @property {number} id
 * @property {string} code
 * @property {string} name
 */

/**
 * @typedef {Object} Carrier
 * @property {number} id
 * @property {string} code
 * @property {string} name
 */

/** @typedef {'loading'|'ready'|'offline'|'retrying'|'failed'} HealthState */

/**
 * @typedef {Object} CarrierPair
 * @property {string} warehouseCode
 * @property {string} carrierCode
 */

export {};
