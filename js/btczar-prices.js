/**
 * btczar-prices.js — Fetch historical BTC/ZAR daily closing prices
 *
 * Primary source:  Binance klines (BTCZAR, free, no key required)
 * Fallback source: CoinGecko market chart (covers post-Binance-delisting dates)
 *
 * Usage:
 *   import { fetchBtcZarPrices } from './btczar-prices.js';
 *
 *   const prices = await fetchBtcZarPrices(1609459200, 1640995200);
 *   // { 1609459200: 523000, 1609545600: 531000, ... }
 */

const BINANCE_URL   = 'https://api.binance.com/api/v3/klines';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range';

async function fetchBinance(fromMs, toMs) {
  const prices = {};
  let startMs = fromMs;

  while (true) {
    const url = `${BINANCE_URL}?symbol=BTCZAR&interval=1d&startTime=${startMs}&endTime=${toMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${await res.text()}`);
    const klines = await res.json();
    if (klines.length === 0) break;

    for (const k of klines) {
      prices[k[0] / 1000] = parseFloat(k[4]); // open time (midnight UTC) → close price
    }

    if (klines.length < 1000) break;
    startMs = klines[klines.length - 1][0] + 86_400_000;
    if (startMs > toMs) break;
  }

  return prices;
}

async function fetchCoinGecko(fromSec, toSec, apiKey) {
  const url = `${COINGECKO_URL}?vs_currency=zar&from=${fromSec}&to=${toSec}`;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}: ${await res.text()}`);
  const { prices } = await res.json();
  if (!prices?.length) throw new Error('CoinGecko returned no data (set coinGeckoApiKey for the free demo tier)');

  const out = {};
  for (const [tsMs, price] of prices) {
    out[Math.floor(tsMs / 86_400_000) * 86400] = price; // normalize to midnight UTC
  }
  return out;
}

/**
 * Fetches BTC/ZAR daily closing prices for the given unix time range.
 *
 * Price keys are midnight UTC (seconds) for each day, matching the format
 * expected by calculateDisposals() in taxcalc.js.
 *
 * Binance is used as the primary source. If its data ends before `to`
 * (BTCZAR was delisted from Binance in early 2026), CoinGecko fills the gap.
 *
 * @param {number} from — unix timestamp (seconds), start of range (inclusive)
 * @param {number} to   — unix timestamp (seconds), end of range (inclusive)
 * @param {{ coinGeckoApiKey?: string }} [options]
 * @returns {Promise<Object<number, number>>}  { unixSeconds: zarPerBtc }
 */
export async function fetchBtcZarPrices(from, to, { coinGeckoApiKey } = {}) {
  const prices = await fetchBinance(from * 1000, to * 1000);

  const keys = Object.keys(prices).map(Number);
  const latest = keys.length ? Math.max(...keys) : from;
  const nextDay = latest + 86400;

  if (nextDay <= to) {
    const cgPrices = await fetchCoinGecko(nextDay, to, coinGeckoApiKey);
    Object.assign(prices, cgPrices);
  }

  return prices;
}
