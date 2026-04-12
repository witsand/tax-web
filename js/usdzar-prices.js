/**
 * usdzar-prices.js — Fetch historical USD/ZAR daily rates
 *
 * Source: Frankfurter API (European Central Bank data, free, no key required)
 *
 * Note: ECB publishes business-day rates only. Saturdays and Sundays have no
 * entry. When used with taxcalc.js, a transaction on a Friday will resolve to
 * Monday's rate (~72 hours later). Set staleThreshold >= 259200 (72 h) on
 * calculateDisposals() to avoid spurious warnings over weekends.
 *
 * Usage:
 *   import { fetchUsdZarPrices } from './usdzar-prices.js';
 *
 *   const prices = await fetchUsdZarPrices(1609459200, 1640995200);
 *   // { 1609459200: 15.47, 1609545600: 15.51, ... }
 */

const FRANKFURTER_URL = 'https://api.frankfurter.app';

function toDateString(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function toUnixSeconds(dateString) {
  return new Date(dateString + 'T00:00:00Z').getTime() / 1000;
}

/**
 * Fetches USD/ZAR daily rates for the given unix time range.
 *
 * Price keys are midnight UTC (seconds) for each business day, matching the
 * format expected by calculateDisposals() in taxcalc.js.
 *
 * @param {number} from — unix timestamp (seconds), start of range (inclusive)
 * @param {number} to   — unix timestamp (seconds), end of range (inclusive)
 * @returns {Promise<Object<number, number>>}  { unixSeconds: zarPerUsd }
 */
export async function fetchUsdZarPrices(from, to) {
  const url = `${FRANKFURTER_URL}/${toDateString(from)}..${toDateString(to)}?from=USD&to=ZAR`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}: ${await res.text()}`);

  const { rates } = await res.json();

  const prices = {};
  for (const [date, currencies] of Object.entries(rates)) {
    if (currencies.ZAR != null) {
      prices[toUnixSeconds(date)] = currencies.ZAR;
    }
  }
  return prices;
}
