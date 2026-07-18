/**
 * Public surface of the shipping layer. Deliberately re-exports ONLY
 * ShippingProvider -- ShippingGateway, OfflineCache, CalculatorEngine, and
 * ShippingHealthService are internal collaborators and must never be
 * imported directly by index.html or any UI code.
 */
export { ShippingProvider } from './provider.js';
