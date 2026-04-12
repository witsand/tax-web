/**
 * taxcalc.js — Generic Lot-Based Disposal Calculator
 *
 * Calculates disposal events from a list of transactions using one of five
 * accounting methods: FIFO, LIFO, HIFO, LCFO, or ACB.
 *
 * Completely unit- and currency-agnostic. You define what a "unit" is and
 * what the price represents. The library just tracks inventory and returns
 * raw disposal data.
 *
 * KNOWN LIMITATION (ACB only):
 *   The ACB engine accumulates a running pool cost as a plain JS Number
 *   (float64). This is safe up to Number.MAX_SAFE_INTEGER (~9×10¹⁵). If
 *   your unit counts and prices are large enough that (units × costPerUnit)
 *   would exceed that, use a lot-based method (FIFO/LIFO/HIFO/LCFO) instead,
 *   or pre-scale your values. The library throws an error if this limit is
 *   exceeded and warns when within 1% of it.
 *
 * Usage:
 *   import { calculateDisposals } from './taxcalc.js';
 *
 *   const transactions = [
 *     { id: 'tx1', time: 1618963200, amount:  1.5, fee: 0.001 },  // inflow
 *     { id: 'tx2', time: 1619049600, amount: -0.5, fee: 0.001 },  // outflow
 *   ];
 *
 *   const prices = {
 *     1618963200: 50000,
 *     1619049600: 52000,
 *   };
 *
 *   const result = calculateDisposals(transactions, prices, 'HIFO', 86400);
 */

// ── Lot picking strategies ─────────────────────────────────────────────────────

/**
 * Maps each method name to a function that, given the current pool, returns
 * the index of the lot to drain next.
 *
 * The pool is an array of lot objects: { txID, units, costPerUnit }
 */
const LOT_PICKERS = {
  // First In, First Out — always take the oldest lot
  FIFO: () => 0,

  // Last In, First Out — always take the newest lot
  LIFO: pool => pool.length - 1,

  // Highest Cost First Out — take the lot with the highest costPerUnit
  HIFO: pool => {
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].costPerUnit > pool[best].costPerUnit) best = i;
    }
    return best;
  },

  // Lowest Cost First Out — take the lot with the lowest costPerUnit
  LCFO: pool => {
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].costPerUnit < pool[best].costPerUnit) best = i;
    }
    return best;
  },
};

// ── Core drain function ────────────────────────────────────────────────────────

/**
 * Removes `units` from the pool using the lot selected by `pickIndex`.
 * Mutates the pool in place (removes exhausted lots).
 *
 * @param {Array<{txID: string, units: number, costPerUnit: number}>} pool
 * @param {number} units  — how many units to drain
 * @param {function} pickIndex  — (pool) => index of next lot to use
 * @returns {{ sources: Array<{txID: string, amount: number, costPerUnit: number}> }}
 *   sources: one entry per lot touched, with the units drawn and the
 *            costPerUnit that was recorded when that lot was acquired
 */
function drainLots(pool, units, pickIndex) {
  const sources = [];
  let remaining = units;
  while (remaining > 0 && pool.length > 0) {
    const idx = pickIndex(pool);
    const use = Math.min(remaining, pool[idx].units);
    sources.push({
      txID: pool[idx].txID,
      amount: use,
      costPerUnit: pool[idx].costPerUnit,
    });
    pool[idx].units -= use;
    if (pool[idx].units === 0) pool.splice(idx, 1);
    remaining -= use;
  }
  return { sources };
}

// ── Price lookup ───────────────────────────────────────────────────────────────

/**
 * Builds a lookup function that, given a transaction timestamp, finds the
 * earliest price at or after that timestamp via binary search.
 *
 * @param {Object<number, number>} prices        — { unixSeconds: pricePerUnit }
 * @param {number}                 staleThreshold — warn if lag exceeds this many seconds
 * @returns {function(number): { costPerUnit: number, ok: boolean, stale: boolean }}
 *   ok is false when no price exists at or after the transaction timestamp.
 *   stale is true when the nearest price is more than staleThreshold seconds away.
 */
function buildLookup(prices, staleThreshold) {
  const sortedKeys = Object.keys(prices).map(Number).sort((a, b) => a - b);

  return function lookup(unixSeconds) {
    let lo = 0, hi = sortedKeys.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedKeys[mid] >= unixSeconds) {
        best = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (best === -1) return { costPerUnit: 0, ok: false, stale: false };
    const key = sortedKeys[best];
    const lag = key - unixSeconds;
    return { costPerUnit: prices[key], ok: true, stale: lag > staleThreshold, lag };
  };
}

// ── Lot-based engine (FIFO / LIFO / HIFO / LCFO) ──────────────────────────────

/**
 * Processes all transactions using a lot-based accounting method.
 *
 * Each inflow creates a new lot in the pool tagged with its acquisition price.
 * Each outflow drains lots from the pool (and any fee is also drained).
 * Fees on both inflows and outflows are recorded as disposals (amount: 0, fee: fee).
 *
 * @param {Array<{id, time, amount, fee}>} transactions
 * @param {function} lookup    — price lookup function from buildLookup
 * @param {number}   staleThreshold
 * @param {function} pickIndex — lot selection strategy from LOT_PICKERS
 * @returns {{ disposals: Array, remainingLots: Array, warnings: string[] }}
 */
function lotBased(transactions, lookup, staleThreshold, pickIndex) {
  const pool = [];
  const disposals = [];
  const warnings = [];

  for (const tx of transactions) {
    if (tx.amount === 0) continue;

    const { costPerUnit, ok, stale, lag } = lookup(tx.time);
    const dir = tx.amount > 0 ? 'inflow' : 'outflow';
    if (!ok) {
      warnings.push(`skipped ${dir} tx ${tx.id} (t=${tx.time}): no price available after this transaction`);
      continue;
    }
    if (stale) {
      warnings.push(`${dir} tx ${tx.id} (t=${tx.time}): nearest price is ${lag}s after transaction`);
    }

    if (tx.amount > 0) {
      // ── Inflow ──────────────────────────────────────────────────────────────
      pool.push({ txID: tx.id, units: tx.amount, costPerUnit });

      if (tx.fee > 0) {
        const { sources: feeSources } = drainLots(pool, tx.fee, pickIndex);
        disposals.push({ txID: tx.id, time: tx.time, amount: 0, fee: tx.fee, proceedsPerUnit: costPerUnit, sources: feeSources });
      }
    } else {
      // ── Outflow ─────────────────────────────────────────────────────────────
      const sold = -tx.amount;
      const { sources } = drainLots(pool, sold, pickIndex);

      let feeSources = [];
      if (tx.fee > 0) {
        ({ sources: feeSources } = drainLots(pool, tx.fee, pickIndex));
      }

      disposals.push({
        txID: tx.id,
        time: tx.time,
        amount: sold,
        fee: tx.fee,
        proceedsPerUnit: costPerUnit,
        sources: sources.concat(feeSources),
      });
    }
  }

  return {
    disposals,
    remainingLots: pool.map(l => ({ txID: l.txID, units: l.units, costPerUnit: l.costPerUnit })),
    warnings,
  };
}

// ── ACB engine (Average Cost Basis) ───────────────────────────────────────────

/**
 * Processes all transactions using the Average Cost Basis method.
 *
 * No individual lots are tracked. Instead, a running total of poolUnits and
 * poolCost is maintained. The average cost at disposal time is poolCost / poolUnits.
 *
 * Disposals are returned with sources: [] since there are no individual lots
 * to point back to.
 *
 * OVERFLOW GUARD: poolCost is accumulated as a plain JS Number. An error is
 * thrown if it exceeds Number.MAX_SAFE_INTEGER, and a warning is pushed if
 * it exceeds 99% of that limit. See module-level comment for details.
 *
 * @param {Array<{id, time, amount, fee}>} transactions
 * @param {function} lookup    — price lookup function from buildLookup
 * @param {number}   staleThreshold
 * @returns {{ disposals: Array, remainingLots: Array, warnings: string[] }}
 */
function acb(transactions, lookup, staleThreshold) {
  let poolUnits = 0;
  let poolCost = 0;
  const disposals = [];
  const warnings = [];

  const SAFE_MAX = Number.MAX_SAFE_INTEGER;
  const WARN_THRESHOLD = SAFE_MAX * 0.99;

  function acbDrain(units) {
    if (poolUnits <= 0) return;
    const costForUnits = (poolCost / poolUnits) * units;
    poolCost -= costForUnits;
    poolUnits -= units;
  }

  for (const tx of transactions) {
    if (tx.amount === 0) continue;

    const { costPerUnit, ok, stale, lag } = lookup(tx.time);
    const dir = tx.amount > 0 ? 'inflow' : 'outflow';
    if (!ok) {
      warnings.push(`skipped ${dir} tx ${tx.id} (t=${tx.time}): no price available after this transaction`);
      continue;
    }
    if (stale) {
      warnings.push(`${dir} tx ${tx.id} (t=${tx.time}): nearest price is ${lag}s after transaction`);
    }

    if (tx.amount > 0) {
      // ── Inflow ──────────────────────────────────────────────────────────────
      poolCost += tx.amount * costPerUnit;
      poolUnits += tx.amount;

      if (poolCost > SAFE_MAX) {
        throw new Error(
          `ACB pool cost exceeded Number.MAX_SAFE_INTEGER after tx ${tx.id} ` +
          `(poolCost=${poolCost}). Precision cannot be guaranteed. ` +
          `Use a lot-based method or pre-scale your values.`
        );
      }
      if (poolCost > WARN_THRESHOLD) {
        warnings.push(
          `ACB pool cost is within 1% of Number.MAX_SAFE_INTEGER after tx ${tx.id} ` +
          `— precision loss may occur soon`
        );
      }

      if (tx.fee > 0) {
        const avgCost = poolUnits > 0 ? poolCost / poolUnits : 0;
        acbDrain(tx.fee);
        disposals.push({
          txID: tx.id, time: tx.time, amount: 0, fee: tx.fee, proceedsPerUnit: costPerUnit,
          sources: [{ txID: 'ACB', amount: tx.fee, costPerUnit: avgCost }],
        });
      }
    } else {
      // ── Outflow ─────────────────────────────────────────────────────────────
      const sold = -tx.amount;
      const avgCost = poolUnits > 0 ? poolCost / poolUnits : 0;
      acbDrain(sold);
      const feeSources = [];
      if (tx.fee > 0) {
        const avgCostAfter = poolUnits > 0 ? poolCost / poolUnits : 0;
        acbDrain(tx.fee);
        feeSources.push({ txID: 'ACB', amount: tx.fee, costPerUnit: avgCostAfter });
      }

      disposals.push({
        txID: tx.id,
        time: tx.time,
        amount: sold,
        fee: tx.fee,
        proceedsPerUnit: costPerUnit,
        sources: [{ txID: 'ACB', amount: sold, costPerUnit: avgCost }, ...feeSources],
      });
    }
  }

  const remainingLots = poolUnits > 0
    ? [{ txID: 'ACB', units: poolUnits, costPerUnit: poolCost / poolUnits }]
    : [];

  return { disposals, remainingLots, warnings };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Calculates disposal events from a list of transactions.
 *
 * @param {Array<{id: string, time: number, amount: number, fee: number}>} transactions
 *   - id:     unique string identifier for the transaction
 *   - time:   unix timestamp in seconds (UTC)
 *   - amount: signed number in your chosen unit (positive = inflow, negative = outflow)
 *   - fee:    non-negative number in the same unit as amount (use 0 if none)
 *
 * @param {Object<number, number>} prices
 *   Maps unix timestamps (seconds) to a price-per-unit number.
 *   The unit and currency are yours to define — the library treats it as an
 *   opaque number. Example: { 1705276800: 42.50 }
 *   For each transaction the library picks the earliest price at or after the
 *   transaction timestamp. Transactions with no such price are skipped with a
 *   warning. Transactions where the nearest price is more than staleThreshold
 *   seconds away are processed but also warned.
 *
 * @param {"FIFO"|"LIFO"|"HIFO"|"LCFO"|"ACB"} method
 *   Accounting method to use:
 *   - FIFO: First In, First Out
 *   - LIFO: Last In, First Out
 *   - HIFO: Highest Cost First Out (default choice for minimising gains)
 *   - LCFO: Lowest Cost First Out
 *   - ACB:  Average Cost Basis (no individual lot tracking; sources will be [])
 *
 * @param {number} staleThreshold
 *   Maximum number of seconds between a transaction and its matched price
 *   before a warning is emitted. The price is still used regardless.
 *
 * @returns {{
 *   disposals: Array<{
 *     txID: string,
 *     time: number,
 *     amount: number,
 *     fee: number,
 *     proceedsPerUnit: number,
 *     sources: Array<{
 *       txID: string,
 *       amount: number,
 *       costPerUnit: number
 *     }>
 *   }>,
 *   remainingLots: Array<{
 *     txID: string,
 *     units: number,
 *     costPerUnit: number
 *   }>,
 *   warnings: string[]
 * }}
 *
 * In each disposal:
 *   - sources lists every lot consumed to cover the outflow (including fee).
 *     Each source carries the costPerUnit that was recorded at acquisition time,
 *     in the same scale as your prices input.
 *   - For ACB, sources is always [].
 *
 * In remainingLots:
 *   - Each entry is an unsold lot still in inventory after all transactions.
 *   - costPerUnit is in the same scale as your prices input.
 *   - For ACB, a single synthetic entry with txID "ACB" is returned if any
 *     units remain.
 */
export function calculateDisposals(transactions, prices, method, staleThreshold) {
  const lookup = buildLookup(prices, staleThreshold);

  if (method === 'ACB') {
    return acb(transactions, lookup, staleThreshold);
  }

  const pickIndex = LOT_PICKERS[method];
  if (!pickIndex) {
    throw new Error(`Unknown method "${method}". Use one of: FIFO, LIFO, HIFO, LCFO, ACB`);
  }

  return lotBased(transactions, lookup, staleThreshold, pickIndex);
}
