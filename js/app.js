import { openDB, db }           from './db.js';
import { calculateDisposals }    from './taxcalc.js';
import { fetchBlinkWallets, fetchBlinkTransactions } from './blink.js';
import { fetchBtcZarPrices }     from './btczar-prices.js';
import { fetchUsdZarPrices }     from './usdzar-prices.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ZAR  = n => `R\u00a0${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const uid  = () => crypto.randomUUID();
const now  = () => Math.floor(Date.now() / 1000);
const dateStr = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const dateToTs = s => new Date(s + 'T00:00:00Z').getTime() / 1000;
const fmtAgo = ts => { if (!ts) return 'never'; const s = now() - ts; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s/60)}m ago`; if (s < 86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`; };

function nativeAmt(amount, currency) {
  if (currency === 'BTC') return `${Math.abs(amount).toLocaleString('en-ZA')} sats`;
  return `$\u00a0${(Math.abs(amount) / 100).toFixed(2)}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function taxYear(ts, sm)      { const d = new Date(ts * 1000); const y = d.getUTCFullYear(), m = d.getUTCMonth(); return m < sm ? y - 1 : y; }
function taxYearLabel(y)      { return `${y}/${String(y + 1).slice(2)}`; }
function taxYearStart(y, sm)  { return Date.UTC(y, sm, 1) / 1000; }
function taxYearEnd(y, sm)    { return Date.UTC(y + 1, sm, 1) / 1000 - 1; }
function walletSm(wallet)     { return wallet.taxYearStartMonth ?? 2; }

// ── State ──────────────────────────────────────────────────────────────────────

let accounts = [];
let wallets  = {};   // accountId → [wallet]
let selectedWalletId = null;
let pricesLastUpdated = { btc: 0, usd: 0 };

// ── Confirm dialog ─────────────────────────────────────────────────────────────

function confirm(msg) {
  return new Promise(resolve => {
    document.getElementById('confirm-msg').textContent = msg;
    openOverlay('overlay-confirm');
    const ok  = document.getElementById('btn-confirm-ok');
    const can = document.getElementById('btn-confirm-cancel');
    const cleanup = val => { closeOverlay('overlay-confirm'); ok.onclick = null; can.onclick = null; resolve(val); };
    ok.onclick  = () => cleanup(true);
    can.onclick = () => cleanup(false);
  });
}

// ── Modal helpers ──────────────────────────────────────────────────────────────

function openOverlay(id)  { document.getElementById(id).classList.add('open'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }

// ── Price syncing ──────────────────────────────────────────────────────────────

async function loadBundledPrices(store, jsonFile) {
  try {
    const res  = await fetch(jsonFile);
    const data = await res.json();
    const entries = Object.entries(data).map(([date, price]) => ({
      time: dateToTs(date),
      price: Number(price),
    }));
    await db.putMany(store, entries);
  } catch (e) {
    console.warn(`Could not load bundled ${jsonFile}:`, e.message);
  }
}

async function syncPrices(hard = false) {
  setLoading('Syncing prices…');
  if (hard) {
    await db.clear('prices_btc');
    await db.clear('prices_usd');
  }

  // BTC
  if ((await db.latestKey('prices_btc')) === 0) await loadBundledPrices('prices_btc', './btc_prices_zar.json');
  const btcLatest = await db.latestKey('prices_btc');
  if (now() - btcLatest > 86400) {
    try {
      const fresh = await fetchBtcZarPrices(btcLatest + 1, now());
      await db.putMany('prices_btc', Object.entries(fresh).map(([t, p]) => ({ time: Number(t), price: p })));
    } catch (e) { console.warn('BTC price fetch failed:', e.message); }
  }

  // USD
  if ((await db.latestKey('prices_usd')) === 0) await loadBundledPrices('prices_usd', './usd_prices_zar.json');
  const usdLatest = await db.latestKey('prices_usd');
  if (now() - usdLatest > 86400) {
    try {
      const fresh = await fetchUsdZarPrices(usdLatest + 1, now());
      await db.putMany('prices_usd', Object.entries(fresh).map(([t, p]) => ({ time: Number(t), price: p })));
    } catch (e) { console.warn('USD price fetch failed:', e.message); }
  }

  pricesLastUpdated.btc = await db.latestKey('prices_btc');
  pricesLastUpdated.usd = await db.latestKey('prices_usd');
  renderPricesStatus();
  clearLoading();
}

function renderPricesStatus() {
  const latest = Math.min(pricesLastUpdated.btc || 0, pricesLastUpdated.usd || 0);
  const el = document.getElementById('prices-status');
  const stale = latest === 0 || now() - latest > 86400 * 2;
  el.innerHTML = `<span class="dot${stale ? ' stale' : ''}"></span>Prices ${latest ? fmtAgo(latest) : 'not loaded'}`;
}

// ── Account / wallet management ────────────────────────────────────────────────

async function loadAccounts() {
  accounts = await db.getAll('accounts');
  wallets  = {};
  const allWallets = await db.getAll('wallets');
  for (const w of allWallets) {
    (wallets[w.accountId] ??= []).push(w);
  }
}

async function syncWallet(wallet, hard = false) {
  const account = accounts.find(a => a.id === wallet.accountId);
  if (!account || account.type !== 'blink') return;

  if (hard) await db.deleteByIndex('transactions', 'walletId', wallet.id);

  const existing = await db.getByIndex('transactions', 'walletId', wallet.id);
  const latestTime = existing.reduce((m, t) => Math.max(m, t.time), 0);

  const txs = await fetchBlinkTransactions(account.apiKey, wallet.blinkWalletId, { from: latestTime });
  if (txs.length) {
    await db.putMany('transactions', txs.map(t => ({
      _key: `${wallet.id}:${t.id}`,
      id:   t.id,
      walletId: wallet.id,
      time: t.time,
      amount: t.amount,
      fee:  t.fee,
    })));
  }

  wallet.lastSynced = now();
  await db.put('wallets', wallet);
}

async function syncAccount(account, hard = false) {
  const ws = wallets[account.id] ?? [];
  for (const w of ws) await syncWallet(w, hard);
}

// ── Tax calculation ────────────────────────────────────────────────────────────

async function calcWallet(wallet) {
  const txs = (await db.getByIndex('transactions', 'walletId', wallet.id))
    .map(t => ({ id: t.id, time: t.time, amount: t.amount, fee: t.fee }));
  const priceMap = await db.asMap(wallet.currency === 'BTC' ? 'prices_btc' : 'prices_usd');
  const scale    = wallet.currency === 'BTC' ? 1e8 : 100;
  const scaled   = Object.fromEntries(Object.entries(priceMap).map(([t, p]) => [t, p / scale]));
  const stale    = wallet.currency === 'BTC' ? 86400 : 259200;
  const result   = calculateDisposals(txs, scaled, wallet.method ?? 'HIFO', stale);
  // Build id→time map so disposal detail rows can show acquisition dates
  result.txMap   = Object.fromEntries(txs.map(t => [t.id, t]));
  return result;
}

function disposalGain(d) {
  const proceeds = d.amount * d.proceedsPerUnit;
  const cost     = d.sources.reduce((s, x) => s + x.amount * x.costPerUnit, 0);
  return { proceeds, cost, gain: proceeds - cost };
}

function summariseByYear(disposals, sm) {
  const years = {};
  for (const d of disposals) {
    const y = taxYear(d.time, sm);
    const { proceeds, cost, gain } = disposalGain(d);
    const yr = (years[y] ??= { proceeds: 0, cost: 0, gain: 0, fees: 0, count: 0 });
    yr.proceeds += proceeds;
    yr.cost     += cost;
    yr.gain     += gain;
    yr.fees     += d.fee * d.proceedsPerUnit;
    yr.count++;
  }
  return years;
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderAccountList() {
  const el = document.getElementById('account-list');

  if (!accounts.length) {
    el.innerHTML = `
      <div class="empty-sidebar">
        <p>No accounts yet.<br>Connect a Blink wallet or upload a CSV to get started.</p>
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('btn-add-account').click()">Add first account</button>
      </div>`;
    return;
  }

  el.innerHTML = accounts.map(acc => {
    const ws         = wallets[acc.id] ?? [];
    const isOpen     = acc._expanded !== false; // default open
    return `
      <div class="account-group">
        <div class="account-header" data-acc="${acc.id}">
          <span class="account-toggle" data-toggle="${acc.id}" style="font-size:10px;color:var(--text-muted);margin-right:4px;transition:transform .15s">${isOpen ? '▼' : '▶'}</span>
          <span class="account-name" title="${acc.name}">${acc.name}</span>
          <span class="account-actions">
            <button class="icon-btn" title="Rename account" data-action="rename-acc" data-acc="${acc.id}">✎</button>
            <button class="icon-btn" title="Refresh transactions" data-action="refresh-acc" data-acc="${acc.id}">↻</button>
            <button class="icon-btn danger" title="Hard refresh (re-fetch all)" data-action="hard-refresh-acc" data-acc="${acc.id}">⟳</button>
            <button class="icon-btn danger" title="Delete account" data-action="delete-acc" data-acc="${acc.id}">✕</button>
          </span>
        </div>
        <div class="wallet-list" id="wallet-list-${acc.id}" ${isOpen ? '' : 'style="display:none"'}>
          ${ws.map(w => `
            <div class="wallet-item${selectedWalletId === w.id ? ' active' : ''}" data-wallet="${w.id}">
              <span class="wallet-currency-badge badge-${w.currency.toLowerCase()}">${w.currency === 'BTC' ? '₿' : '$'}</span>
              <span class="wallet-label">${w.currency} Wallet</span>
              <span class="wallet-synced">${w.lastSynced ? fmtAgo(w.lastSynced) : '–'}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

async function renderWalletDetail(walletId) {
  const wallet = Object.values(wallets).flat().find(w => w.id === walletId);
  if (!wallet) return;
  const account = accounts.find(a => a.id === wallet.accountId);

  const el = document.getElementById('wallet-detail');
  el.classList.remove('hidden');
  document.getElementById('empty-detail').classList.add('hidden');

  // Get all txs to find earliest time for default date range
  const txs = await db.getByIndex('transactions', 'walletId', walletId);
  const earliest = txs.reduce((m, t) => Math.min(m, t.time), Infinity);
  const sm          = walletSm(wallet);
  const defaultFrom = taxYearStart(taxYear(now(), sm), sm);
  const defaultTo   = now();

  const fromVal = dateStr(defaultFrom);
  const toVal   = dateStr(defaultTo);

  el.innerHTML = `
    <button class="btn-back">‹ Accounts</button>
    <div class="detail-header">
      <div>
        <div class="detail-title">
          ${wallet.currency === 'BTC' ? '₿' : '$'} ${wallet.currency} Wallet
          <span>— ${account?.name ?? ''}</span>
        </div>
        <div class="detail-meta">Last synced: ${wallet.lastSynced ? fmtAgo(wallet.lastSynced) : 'never'}</div>
      </div>
      <div class="ctrl-group" style="align-self:center">
        <label for="sel-method" style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-right:6px">Method</label>
        <select id="sel-method" style="border:1px solid var(--border-mid);border-radius:var(--radius);padding:5px 8px;font-size:13px;color:var(--text);background:var(--surface);cursor:pointer">
          ${['FIFO','LIFO','HIFO','LCFO','ACB'].map(m => `<option${wallet.method === m ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
    </div>

    <div id="tax-results" data-default-from="${fromVal}" data-default-to="${toVal}">
      <div class="loading-state"><div class="spinner"></div> Calculating…</div>
    </div>`;

  // Wire up controls
  document.getElementById('sel-method').addEventListener('change', async e => {
    wallet.method = e.target.value;
    await db.put('wallets', wallet);
    await refreshTaxResults(wallet);
  });

  await refreshTaxResults(wallet);
}

async function refreshTaxResults(wallet) {
  const el = document.getElementById('tax-results');
  if (!el) return;

  // Preserve filter values across re-renders
  const fromVal = document.getElementById('inp-from')?.value ?? el.dataset.defaultFrom ?? dateStr(taxYearStart(taxYear(now())));
  const toVal   = document.getElementById('inp-to')?.value   ?? el.dataset.defaultTo   ?? dateStr(now());

  el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calculating…</div>`;

  let result;
  try {
    result = await calcWallet(wallet);
  } catch (e) {
    el.innerHTML = `<div class="warnings-box"><p style="color:var(--loss)">${e.message}</p></div>`;
    return;
  }

  // Yearly summary uses ALL disposals (no date filter)
  const sm           = walletSm(wallet);
  const allDisposals = result.disposals;
  const summary      = summariseByYear(allDisposals, sm);
  const years        = Object.keys(summary).map(Number).sort();

  // Disposals table filtered by From/To
  const fromTs  = dateToTs(fromVal);
  const toTs    = dateToTs(toVal) + 86399;
  const inRange = allDisposals.filter(d => d.time >= fromTs && d.time <= toTs).reverse();

  const monthOptions = MONTHS.map((m, i) =>
    `<option value="${i}"${i === sm ? ' selected' : ''}>${m}</option>`
  ).join('');

  const PAGE_SIZE = 5;

  el.innerHTML = `
    ${result.warnings.length ? `
    <details class="warnings-box" style="margin-bottom:4px">
      <summary>⚠ ${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''}</summary>
      <ul>${result.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </details>` : ''}

    ${years.length ? `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Yearly Summary</span>
        <span style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:6px">
          Tax year starts 1
          <select id="sel-tax-month" style="border:1px solid var(--border-mid);border-radius:4px;padding:2px 4px;font-size:12px;color:var(--text);background:var(--bg);cursor:pointer">
            ${monthOptions}
          </select>
        </span>
      </div>
      <div class="card-body">
        <table class="tbl-yearly">
          <thead><tr>
            <th>Tax Year</th>
            <th class="num">Count</th>
            <th class="num">Spent</th>
            <th class="num">Cost Basis</th>
            <th class="num">Net Gain / Loss</th>
            <th class="num">Total Fees</th>
          </tr></thead>
          <tbody>
            ${years.map(y => {
              const r = summary[y];
              return `<tr>
                <td><span class="year-label">${taxYearLabel(y)}</span></td>
                <td class="num muted">${r.count}</td>
                <td class="num">${ZAR(r.proceeds)}</td>
                <td class="num">${ZAR(r.cost)}</td>
                <td class="num ${r.gain >= 0 ? 'gain-val' : 'loss-val'}">${ZAR(r.gain)}</td>
                <td class="num muted">${ZAR(r.fees)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="card" style="margin-top:12px">
      <div class="card-header">
        <span class="card-title">Spending</span>
        <span style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--text-muted)">From</span>
          <span class="date-picker-wrap">
            <input type="text" id="inp-from" value="${fromVal}" placeholder="yyyy-mm-dd" maxlength="10">
            <input type="date" class="date-picker-native" value="${fromVal}" tabindex="-1">
            <button class="date-picker-btn" tabindex="-1">📅</button>
          </span>
          <span style="font-size:12px;color:var(--text-muted)">To</span>
          <span class="date-picker-wrap">
            <input type="text" id="inp-to" value="${toVal}" placeholder="yyyy-mm-dd" maxlength="10">
            <input type="date" class="date-picker-native" value="${toVal}" tabindex="-1">
            <button class="date-picker-btn" tabindex="-1">📅</button>
          </span>
        </span>
      </div>
      <div class="card-body">
        ${inRange.length ? `
        <table>
          <thead><tr>
            <th style="width:28px"></th>
            <th>Date</th>
            <th class="num">${wallet.currency === 'BTC' ? 'Sats' : 'Amount'}</th>
            <th class="num">ZAR</th>
            <th class="num">Fee</th>
          </tr></thead>
          <tbody id="disposals-tbody">
            ${inRange.map((d, i) => {
              const { proceeds, cost, gain } = disposalGain(d);
              const feeZar = d.fee * d.proceedsPerUnit;
              const sourceRows = d.sources.map(s => {
                const acqTx    = result.txMap[s.txID];
                const acqDate  = acqTx ? dateStr(acqTx.time) : '–';
                const lotTotal = acqTx ? nativeAmt(Math.abs(acqTx.amount), wallet.currency) : '–';
                const used     = nativeAmt(s.amount, wallet.currency);
                const rate     = wallet.currency === 'BTC'
                  ? `${(s.costPerUnit * 100).toFixed(4)}c / sat`
                  : `R ${(s.costPerUnit * 100).toLocaleString('en-ZA', { maximumFractionDigits: 4 })} / USD`;
                return `<tr class="lot-row">
                  <td></td>
                  <td class="muted" style="font-size:11px;padding-left:32px">${acqDate}</td>
                  <td style="font-size:11px;color:var(--text-muted);font-family:monospace;word-break:break-all">${s.txID}</td>
                  <td class="num" style="font-size:11px" title="Total lot size">${lotTotal}</td>
                  <td class="num" style="font-size:11px" title="Used in this disposal">${used}</td>
                  <td class="num" style="font-size:11px">${rate}</td>
                </tr>`;
              }).join('');
              const cols  = 5;
              const extra = i >= PAGE_SIZE ? ' disposal-extra hidden' : '';
              return `<tr class="disposal-row${extra}" data-idx="${i}" style="cursor:pointer">
                <td style="color:var(--text-muted);font-size:11px;text-align:center">▶</td>
                <td class="muted">${dateStr(d.time)}</td>
                <td class="num">${d.amount > 0 ? nativeAmt(d.amount, wallet.currency) : '–'}</td>
                <td class="num">${ZAR(proceeds)}</td>
                <td class="num muted">${feeZar > 0 ? ZAR(feeZar) : '–'}</td>
              </tr>
              <tr class="lot-group hidden" data-group="${i}">
                <td colspan="${cols}" style="padding:0;background:var(--bg)">
                  <table style="width:100%;border-collapse:collapse">
                    <thead>
                      <tr style="background:var(--bg);border-bottom:1px solid var(--border)">
                        <td colspan="6" style="padding:8px 14px 6px 14px">
                          <span style="font-size:12px;color:var(--text-muted);font-family:monospace">${d.txID}</span>
                          <span style="font-size:12px;color:var(--text-mid);margin-left:16px">Cost Basis: <strong>${ZAR(cost)}</strong></span>
                          <span style="font-size:12px;color:var(--text-mid);margin-left:16px">Gain / Loss: <strong class="${gain >= 0 ? 'gain-val' : 'loss-val'}">${ZAR(gain)}</strong></span>
                        </td>
                      </tr>
                      <tr style="background:var(--bg)">
                        <th style="width:28px"></th>
                        <th style="padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);text-align:left">Acquired</th>
                        <th style="padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);text-align:left">Tx ID</th>
                        <th style="padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);text-align:right">Lot Total</th>
                        <th style="padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);text-align:right">Used</th>
                        <th style="padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);text-align:right">Acquired Rate</th>
                      </tr>
                    </thead>
                    <tbody>${sourceRows}</tbody>
                  </table>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${inRange.length > PAGE_SIZE ? `
        <div style="padding:10px 14px;border-top:1px solid var(--border)">
          <button id="btn-show-more" class="btn btn-secondary btn-sm">Show ${inRange.length - PAGE_SIZE} more</button>
        </div>` : ''}
        ` : `<div style="padding:24px;text-align:center;color:var(--text-muted)">No disposals in selected date range.</div>`}
      </div>
    </div>

    `;

  // Tax year start month — persisted per wallet
  document.getElementById('sel-tax-month')?.addEventListener('change', async e => {
    wallet.taxYearStartMonth = parseInt(e.target.value, 10);
    await db.put('wallets', wallet);
    await refreshTaxResults(wallet);
  });

  // Show more / show all
  document.getElementById('btn-show-more')?.addEventListener('click', e => {
    el.querySelectorAll('.disposal-extra').forEach(r => r.classList.remove('hidden'));
    e.target.closest('div').remove();
  });

  // Disposal date filters
  const isValidDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

  ['inp-from', 'inp-to'].forEach(id => {
    const text   = document.getElementById(id);
    if (!text) return;
    const wrap   = text.closest('.date-picker-wrap');
    const native = wrap.querySelector('.date-picker-native');
    const btn    = wrap.querySelector('.date-picker-btn');

    // Calendar icon opens the native picker
    btn.addEventListener('click', () => native.showPicker?.() ?? native.click());

    // Native picker → copy yyyy-mm-dd into text input and recalc
    native.addEventListener('change', () => {
      text.value = native.value;
      text.style.borderColor = '';
      refreshTaxResults(wallet);
    });

    // Manual text entry → validate and recalc on blur
    text.addEventListener('change', () => {
      const valid = isValidDate(text.value);
      text.style.borderColor = valid ? '' : 'var(--loss)';
      if (valid) { native.value = text.value; refreshTaxResults(wallet); }
    });
  });

  // Expand/collapse disposal rows
  el.querySelectorAll('.disposal-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx   = row.dataset.idx;
      const group = el.querySelector(`.lot-group[data-group="${idx}"]`);
      const arrow = row.querySelector('td:first-child');
      const open  = !group.classList.contains('hidden');
      group.classList.toggle('hidden', open);
      arrow.textContent = open ? '▶' : '▼';
    });
  });
}

// ── Add Account Modal ──────────────────────────────────────────────────────────

let addStep = 1, addType = 'blink', addFetchedWallets = [], addCsvRows = [], addCsvDenom = 'sats', addName = '';

function openAddAccountModal() {
  addStep = 1; addType = 'blink'; addFetchedWallets = []; addCsvRows = []; addName = '';
  renderAddStep();
  openOverlay('overlay-add-account');
}

function renderAddStep() {
  const body   = document.getElementById('add-modal-body');
  const footer = document.getElementById('add-modal-footer');
  document.getElementById('add-modal-title').textContent = addStep === 1 ? 'Add Account' : addType === 'blink' ? 'Connect Blink' : 'Upload CSV';

  if (addStep === 1) {
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label">Account Name</label>
        <input class="form-input" id="add-name" placeholder="e.g. My Blink Account" value="">
      </div>
      <div class="form-group">
        <label class="form-label">Account Type</label>
        <div class="type-toggle">
          <button class="type-btn${addType === 'blink' ? ' active' : ''}" data-type="blink">⚡ Blink</button>
          <button class="type-btn${addType === 'csv'   ? ' active' : ''}" data-type="csv">📄 Upload CSV</button>
        </div>
      </div>`;
    footer.innerHTML = `
      <button class="btn btn-secondary" id="btn-add-cancel">Cancel</button>
      <button class="btn btn-primary" id="btn-add-next">Next →</button>`;

    body.querySelectorAll('.type-btn').forEach(btn => btn.addEventListener('click', () => {
      addType = btn.dataset.type;
      body.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === addType));
    }));
    document.getElementById('btn-add-cancel').addEventListener('click', () => closeOverlay('overlay-add-account'));
    document.getElementById('btn-add-next').addEventListener('click', () => {
      addName = document.getElementById('add-name').value.trim();
      if (!addName) { document.getElementById('add-name').focus(); return; }
      addStep = 2; renderAddStep();
    });

  } else if (addType === 'blink') {
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label">Blink API Key</label>
        <input class="form-input" id="add-apikey" type="password" placeholder="Enter your Blink API key">
      </div>
      <div id="fetch-wallets-status"></div>
      <div id="fetch-wallets-list"></div>`;
    footer.innerHTML = `
      <button class="btn btn-secondary" id="btn-add-back">← Back</button>
      <button class="btn btn-secondary" id="btn-fetch-wallets">Fetch Wallets</button>
      <button class="btn btn-primary hidden" id="btn-blink-save">Save Account</button>`;

    document.getElementById('btn-add-back').addEventListener('click', () => { addStep = 1; renderAddStep(); });
    document.getElementById('btn-fetch-wallets').addEventListener('click', async () => {
      const key = document.getElementById('add-apikey').value.trim();
      if (!key) return;
      const status = document.getElementById('fetch-wallets-status');
      status.innerHTML = `<div class="loading-state"><div class="spinner"></div> Fetching wallets…</div>`;
      try {
        addFetchedWallets = await fetchBlinkWallets(key);
        status.innerHTML = '';
        document.getElementById('fetch-wallets-list').innerHTML = `
          <div class="wallet-fetch-list">
            ${addFetchedWallets.map(w => `
              <div class="wallet-fetch-item">
                <span class="wallet-currency-badge badge-${w.currency.toLowerCase()}">${w.currency === 'BTC' ? '₿' : '$'}</span>
                <span>${w.currency} Wallet</span>
              </div>`).join('')}
          </div>`;
        document.getElementById('btn-blink-save').classList.remove('hidden');
      } catch (e) {
        status.innerHTML = `<p style="color:var(--loss);font-size:13px;margin-top:8px">Error: ${e.message}</p>`;
      }
    });
    document.getElementById('btn-blink-save').addEventListener('click', () => saveBlinkAccount());

  } else {
    body.innerHTML = `
      <div class="form-group">
        <label class="form-label">CSV File</label>
        <input class="form-input" id="add-csv-file" type="file" accept=".csv">
        <p class="form-hint">id,time,amount,fee</p>
      </div>
      <div class="form-group">
        <label class="form-label">Unit Denomination</label>
        <select class="form-select" id="add-denom">
          <option value="sats">Satoshis (BTC wallet)</option>
          <option value="btc">BTC → convert to sats (BTC wallet)</option>
          <option value="cents">US Cents (USD wallet)</option>
          <option value="usd">USD → convert to cents (USD wallet)</option>
        </select>
      </div>
      <div id="csv-preview-box"></div>`;
    footer.innerHTML = `
      <button class="btn btn-secondary" id="btn-add-back">← Back</button>
      <button class="btn btn-primary hidden" id="btn-csv-save">Save Account</button>`;

    document.getElementById('btn-add-back').addEventListener('click', () => { addStep = 1; renderAddStep(); });
    document.getElementById('add-denom').addEventListener('change', e => { addCsvDenom = e.target.value; });
    document.getElementById('add-csv-file').addEventListener('change', e => parseCsvFile(e.target.files[0]));
    document.getElementById('btn-csv-save').addEventListener('click', () => saveCsvAccount());
  }
}

function parseCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.trim().split('\n');
    const header = lines[0]?.toLowerCase().replace(/\r/g, '');
    const preview = document.getElementById('csv-preview-box');

    if (!header || !['id,time,amount,fee'].includes(header)) {
      preview.innerHTML = `<p style="color:var(--loss);font-size:13px;margin-top:8px">Invalid format. Expected header: id,time,amount,fee</p>`;
      return;
    }

    addCsvRows = lines.slice(1).filter(l => l.trim()).map(l => {
      const [id, time, amount, fee] = l.replace(/\r/g, '').split(',');
      return { id: id?.trim(), time: Number(time), amount: Number(amount), fee: Number(fee) };
    }).filter(r => r.id && !isNaN(r.time) && !isNaN(r.amount) && !isNaN(r.fee));

    const sample = lines.slice(0, 4);
    preview.innerHTML = `
      <div class="csv-preview">
        ${sample.map((l, i) => `<div class="csv-preview-row${i===0?' header-row':''}">${l.replace(/\r/g,'')}</div>`).join('')}
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:6px">${addCsvRows.length} valid rows detected</p>`;
    document.getElementById('btn-csv-save').classList.remove('hidden');
  };
  reader.readAsText(file);
}

async function saveBlinkAccount() {
  const name   = addName;
  const apiKey = document.getElementById('add-apikey')?.value.trim() || '';
  if (!name || !apiKey || !addFetchedWallets.length) return;

  const accId = uid();
  await db.put('accounts', { id: accId, name, type: 'blink', apiKey });

  for (const w of addFetchedWallets) {
    await db.put('wallets', { id: uid(), accountId: accId, blinkWalletId: w.id, currency: w.currency, method: 'HIFO', lastSynced: 0 });
  }

  closeOverlay('overlay-add-account');
  await loadAccounts();
  renderAccountList();

  for (const w of wallets[accId] ?? []) {
    try { await syncWallet(w); } catch (e) { console.warn('Sync failed:', e.message); }
  }
  renderAccountList();
}

async function saveCsvAccount() {
  const name  = addName;
  const denom = document.getElementById('add-denom')?.value ?? 'sats';
  if (!name || !addCsvRows.length) return;

  const multiplier = { sats: 1, btc: 1e8, cents: 1, usd: 100 }[denom] ?? 1;
  const currency   = (denom === 'btc' || denom === 'sats') ? 'BTC' : 'USD';

  const accId = uid();
  const wId   = uid();
  await db.put('accounts', { id: accId, name, type: 'csv' });
  await db.put('wallets',  { id: wId, accountId: accId, currency, method: 'HIFO', lastSynced: now() });

  const txEntries = addCsvRows.map(r => ({
    _key: `${wId}:${r.id}`,
    id:   r.id,
    walletId: wId,
    time:   r.time,
    amount: Math.round(r.amount * multiplier),
    fee:    Math.round(r.fee    * multiplier),
  }));
  await db.putMany('transactions', txEntries);

  closeOverlay('overlay-add-account');
  await loadAccounts();
  renderAccountList();
}

// ── Loading helpers ────────────────────────────────────────────────────────────

function setLoading(msg) { const el = document.getElementById('loading-msg'); if (el) el.textContent = msg; }
function clearLoading()  {}

// ── Event delegation ───────────────────────────────────────────────────────────

function attachEvents() {
  // Sidebar account/wallet clicks
  document.getElementById('account-list').addEventListener('click', async e => {
    const actionEl = e.target.closest('[data-action]');
    const action   = actionEl?.dataset.action;
    const accId    = actionEl?.dataset.acc ?? e.target.closest('[data-acc]')?.dataset.acc;
    const wId      = e.target.dataset.wallet ?? e.target.closest('[data-wallet]')?.dataset.wallet;

    // Toggle account wallet list
    const toggleId = e.target.dataset.toggle ?? e.target.closest('[data-toggle]')?.dataset.toggle;
    if (toggleId) {
      const acc  = accounts.find(a => a.id === toggleId);
      if (acc) {
        acc._expanded = acc._expanded === false ? true : false;
        const list   = document.getElementById(`wallet-list-${toggleId}`);
        const arrow  = e.target.closest('.account-header')?.querySelector('.account-toggle');
        if (list)  list.style.display  = acc._expanded === false ? 'none' : '';
        if (arrow) arrow.textContent   = acc._expanded === false ? '▶' : '▼';
      }
      return;
    }

    if (action === 'add-wallet') {
      openAddAccountModal();
      return;
    }

    if (action === 'rename-acc') {
      const acc = accounts.find(a => a.id === accId);
      if (!acc) return;
      const nameEl = e.target.closest('.account-header')?.querySelector('.account-name');
      if (!nameEl) return;
      const input = document.createElement('input');
      input.value = acc.name;
      input.style.cssText = 'flex:1;font-size:13px;font-weight:600;border:1px solid var(--blue);border-radius:3px;padding:1px 5px;outline:none;min-width:0';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== acc.name) {
          acc.name = newName;
          await db.put('accounts', { ...acc });
        }
        renderAccountList();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.removeEventListener('blur', commit); renderAccountList(); }
      });
      return;
    }

    if (action === 'delete-acc') {
      const acc = accounts.find(a => a.id === accId);
      if (!acc) return;
      if (!(await confirm(`Delete "${acc.name}" and all its transactions? This cannot be undone.`))) return;
      const ws = wallets[acc.id] ?? [];
      for (const w of ws) await db.deleteByIndex('transactions', 'walletId', w.id);
      for (const w of ws) await db.delete('wallets', w.id);
      await db.delete('accounts', acc.id);
      if (ws.some(w => w.id === selectedWalletId)) {
        selectedWalletId = null;
        document.getElementById('wallet-detail').classList.add('hidden');
        document.getElementById('empty-detail').classList.remove('hidden');
      }
      await loadAccounts();
      renderAccountList();
      return;
    }

    if (action === 'refresh-acc') {
      const acc = accounts.find(a => a.id === accId);
      if (!acc) return;
      e.target.textContent = '…';
      try { await syncAccount(acc, false); } catch (err) { console.warn(err); }
      renderAccountList();
      if (selectedWalletId) renderWalletDetail(selectedWalletId);
      return;
    }
    if (action === 'hard-refresh-acc') {
      const acc = accounts.find(a => a.id === accId);
      if (!acc || !(await confirm(`Delete all cached transactions for "${acc.name}" and re-fetch from scratch?`))) return;
      try { await syncAccount(acc, true); } catch (err) { console.warn(err); }
      renderAccountList();
      if (selectedWalletId) renderWalletDetail(selectedWalletId);
      return;
    }
    if (wId) {
      selectedWalletId = wId;
      renderAccountList();
      await renderWalletDetail(wId);
      collapseSidebarOnMobile();
    }
  });

  // Mobile sidebar collapse
  function collapseSidebarOnMobile() {
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.add('sidebar-hidden');
    }
  }
  function expandSidebar() {
    document.getElementById('sidebar').classList.remove('sidebar-hidden');
  }

  // Back button in detail panel (delegated — button is injected by renderWalletDetail)
  document.getElementById('detail').addEventListener('click', e => {
    if (e.target.closest('.btn-back')) {
      selectedWalletId = null;
      document.getElementById('wallet-detail').classList.add('hidden');
      document.getElementById('empty-detail').classList.remove('hidden');
      renderAccountList();
      expandSidebar();
    }
  });

  // Header buttons
  document.getElementById('btn-add-account').addEventListener('click', () => openAddAccountModal());
  document.getElementById('btn-show-welcome').addEventListener('click', () => openOverlay('overlay-welcome'));
  document.getElementById('btn-refresh-prices').addEventListener('click', async () => {
    await syncPrices(false);
    if (selectedWalletId) await refreshTaxResults(Object.values(wallets).flat().find(w => w.id === selectedWalletId));
  });
  document.getElementById('btn-hard-refresh-prices').addEventListener('click', async () => {
    if (!(await confirm('Clear all cached price data and re-fetch everything from scratch?'))) return;
    await syncPrices(true);
    if (selectedWalletId) await refreshTaxResults(Object.values(wallets).flat().find(w => w.id === selectedWalletId));
  });

  // Welcome modal
  document.getElementById('chk-agree').addEventListener('change', e => {
    document.getElementById('btn-continue').disabled = !e.target.checked;
  });
  document.getElementById('btn-continue').addEventListener('click', () => {
    localStorage.setItem('termsAccepted', '1');
    closeOverlay('overlay-welcome');
  });

  document.getElementById('btn-close-add').addEventListener('click', () => closeOverlay('overlay-add-account'));
}

// ── Main init ──────────────────────────────────────────────────────────────────

async function main() {
  await openDB();

  if (!localStorage.getItem('termsAccepted')) {
    openOverlay('overlay-welcome');
  }

  attachEvents();

  setLoading('Loading price data…');
  await syncPrices(false);

  setLoading('Loading accounts…');
  await loadAccounts();

  // Fade out loading screen
  const ls = document.getElementById('loading-screen');
  ls.classList.add('fade-out');
  setTimeout(() => ls.classList.add('hidden'), 400);
  document.getElementById('app').classList.remove('hidden');

  renderAccountList();
}

main().catch(e => {
  console.error(e);
  document.getElementById('loading-msg').textContent = `Error: ${e.message}`;
});
