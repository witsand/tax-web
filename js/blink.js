/**
 * blink-transactions.js — Fetch Blink wallet transaction history
 *
 * Fetches all successful transactions for a given Blink wallet and returns
 * them in the format expected by calculateDisposals() in taxcalc.js.
 *
 * Usage:
 *   import { fetchBlinkWallets, fetchBlinkTransactions } from './blink-transactions.js';
 *
 *   const wallets = await fetchBlinkWallets(apiKey);
 *   // [{ id: 'abc123', currency: 'BTC' }, { id: 'def456', currency: 'USD' }]
 *
 *   const transactions = await fetchBlinkTransactions(apiKey, walletId);
 *   const transactions = await fetchBlinkTransactions(apiKey, walletId, { from: 1609459200, to: 1640995200 });
 */

const BLINK_URL = 'https://api.blink.sv/graphql';
const PAGE_SIZE = 50;

const TX_QUERY = `
  query GetTransactions($first: Int!, $after: String) {
    me {
      defaultAccount {
        wallets {
          id
          transactions(first: $first, after: $after) {
            edges {
              cursor
              node {
                id
                createdAt
                direction
                status
                settlementAmount
                settlementFee
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }
`;

async function doQuery(apiKey, query, variables) {
  const res = await fetch(BLINK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Blink HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`Blink GraphQL: ${errors.map(e => e.message).join('; ')}`);
  return data;
}

/**
 * Returns the available wallets on the Blink account.
 *
 * @param {string} apiKey — Blink API key (X-API-KEY)
 * @returns {Promise<Array<{ id: string, currency: string }>>}
 */
export async function fetchBlinkWallets(apiKey) {
  const data = await doQuery(apiKey, `
    query { me { defaultAccount { wallets { id walletCurrency } } } }
  `, {});
  return data.me.defaultAccount.wallets.map(w => ({ id: w.id, currency: w.walletCurrency }));
}

/**
 * Fetches transaction history for a single Blink wallet.
 *
 * @param {string} apiKey   — Blink API key (X-API-KEY)
 * @param {string} walletId — Blink wallet ID (BTC or USD wallet)
 * @param {{ from?: number, to?: number }} [options]
 *   - from: unix timestamp (seconds) — only include transactions at or after this time (default: 0)
 *   - to:   unix timestamp (seconds) — only include transactions at or before this time (default: now)
 * @returns {Promise<Array<{ id: string, time: number, amount: number, fee: number }>>}
 *   Sorted oldest-first. amount is in satoshis (BTC) or cents (USD);
 *   positive = receive, negative = send. fee is always non-negative.
 */
export async function fetchBlinkTransactions(apiKey, walletId, { from = 0, to = Math.floor(Date.now() / 1000) } = {}) {
  const results = [];
  let cursor = null;
  let done = false;

  while (!done) {
    const variables = { first: PAGE_SIZE, ...(cursor && { after: cursor }) };
    const data = await doQuery(apiKey, TX_QUERY, variables);

    const wallet = data.me.defaultAccount.wallets.find(w => w.id === walletId);
    if (!wallet) throw new Error(`Wallet ${walletId} not found`);

    const { edges, pageInfo } = wallet.transactions;

    for (const { node: tx } of edges) {
      // API returns newest-first; stop once we pass the start of the requested window
      if (tx.createdAt < from) { done = true; break; }
      if (tx.status !== 'SUCCESS') continue;
      if (tx.createdAt > to) continue;

      const amount = tx.direction === 'SEND'
        ? -Math.abs(Number(tx.settlementAmount))
        :  Math.abs(Number(tx.settlementAmount));

      results.push({ id: tx.id, time: tx.createdAt, amount, fee: Math.abs(Number(tx.settlementFee)) });
    }

    if (!pageInfo.hasNextPage || done) break;
    cursor = pageInfo.endCursor;
  }

  return results.reverse(); // API is newest-first; return oldest-first
}
