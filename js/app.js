import { openDB, db }           from './db.js';
import { calculateDisposals }    from './taxcalc.js';
import { fetchBlinkWallets, fetchBlinkTransactions, fetchBlinkAuthScopes } from './blink.js';
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
  const stale  = latest === 0 || now() - latest > 86400 * 2;
  document.getElementById('prices-dot').className  = `dot${stale ? ' stale' : ''}`;
  document.getElementById('prices-text').textContent = `Prices ${latest ? fmtAgo(latest) : 'not loaded'}`;
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
    })).sort((a, b) => a.time - b.time || (a.amount >= 0 ? 0 : 1) - (b.amount >= 0 ? 0 : 1)));
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
  const txs = (await db.getTransactionsSorted(wallet.id))
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

function summariseByMonth(disposals, sm) {
  const data = {};
  for (const d of disposals) {
    const y  = taxYear(d.time, sm);
    const mo = new Date(d.time * 1000).getUTCMonth();
    const yr = (data[y] ??= {});
    const mn = (yr[mo] ??= { proceeds: 0, cost: 0, gain: 0, fees: 0, count: 0, disposals: [] });
    const { proceeds, cost, gain } = disposalGain(d);
    mn.proceeds += proceeds;
    mn.cost     += cost;
    mn.gain     += gain;
    mn.fees     += d.fee * d.proceedsPerUnit;
    mn.count++;
    mn.disposals.push(d);
  }
  return data;
}

function renderDisposalTable(disposals, wallet, result) {
  const rows = [...disposals].reverse().map((d, i) => {
    const { proceeds, cost, gain } = disposalGain(d);
    const feeZar    = d.fee * d.proceedsPerUnit;
    const sourceRows = d.sources.map(s => {
      const acqTx   = result.txMap[s.txID];
      const acqDate = acqTx ? dateStr(acqTx.time) : '–';
      const lotTotal = acqTx ? nativeAmt(Math.abs(acqTx.amount), wallet.currency) : '–';
      const used    = nativeAmt(s.amount, wallet.currency);
      const rate    = wallet.currency === 'BTC'
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
    return `<tr class="disposal-row" data-idx="${i}" style="cursor:pointer">
        <td style="color:var(--text-muted);font-size:11px;text-align:center">▶</td>
        <td class="muted">${dateStr(d.time)}</td>
        <td class="num">${d.amount > 0 ? nativeAmt(d.amount, wallet.currency) : '–'}</td>
        <td class="num">${ZAR(proceeds)}</td>
        <td class="num muted">${feeZar > 0 ? ZAR(feeZar) : '–'}</td>
      </tr>
      <tr class="lot-group hidden" data-group="${i}">
        <td colspan="5" style="padding:0;background:var(--bg)">
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
  }).join('');

  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr>
      <th style="width:28px"></th>
      <th>Date</th>
      <th class="num">${wallet.currency === 'BTC' ? 'Sats' : 'Amount'}</th>
      <th class="num">ZAR</th>
      <th class="num">Fee</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderAccountList() {
  const el      = document.getElementById('account-list');
  const emptyEl = document.getElementById('sidebar-empty');

  if (!accounts.length) {
    emptyEl.classList.remove('hidden');
    el.innerHTML = '';
    return;
  }

  emptyEl.classList.add('hidden');
  el.innerHTML = accounts.map(acc => {
    const ws         = wallets[acc.id] ?? [];
    const isOpen     = acc._expanded !== false; // default open
    return `
      <div class="account-group">
        <div class="account-header" data-acc="${acc.id}">
          <span class="account-toggle" data-toggle="${acc.id}" style="font-size:10px;color:var(--text-muted);margin-right:4px;transition:transform .15s">${isOpen ? '▼' : '▶'}</span>
          <span class="account-name" title="${acc.name}">${acc.name}<span class="acct-type-label"> - <img src="images/${acc.type === 'blink' ? 'blink' : 'csv'}.svg" class="acct-type-icon" alt="${acc.type === 'blink' ? 'Blink' : 'CSV'}"></span></span>
          <span class="account-actions">
            <button class="icon-btn" title="Rename account" data-action="rename-acc" data-acc="${acc.id}">✎</button>
            <button class="icon-btn danger" title="Delete account" data-action="delete-acc" data-acc="${acc.id}">✕</button>
          </span>
        </div>
        <div class="wallet-list" id="wallet-list-${acc.id}" ${isOpen ? '' : 'style="display:none"'}>
          ${ws.map(w => `
            <div class="wallet-item${selectedWalletId === w.id ? ' active' : ''}" data-wallet="${w.id}">
              <span class="wallet-currency-badge badge-${w.currency.toLowerCase()}">${w.currency === 'BTC' ? '₿' : '$'}</span>
              <span class="wallet-label">${w.currency === 'BTC' ? 'Bitcoin' : 'US Dollar'}</span>
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

  document.getElementById('wallet-detail').classList.remove('hidden');
  document.getElementById('empty-detail').classList.add('hidden');

  document.getElementById('wd-account-name').textContent  = account?.name ?? '';
  document.getElementById('wd-type-icon').src              = `images/${account?.type === 'blink' ? 'blink' : 'csv'}.svg`;
  document.getElementById('wd-type-icon').alt              = account?.type === 'blink' ? 'Blink' : 'CSV';
  document.getElementById('wd-type-label').textContent     = account?.type === 'blink' ? '' : 'CSV File';
  const badge = document.getElementById('wd-currency-badge');
  badge.className   = `wallet-currency-badge badge-${wallet.currency.toLowerCase()}`;
  badge.textContent = wallet.currency === 'BTC' ? '₿' : '$';
  document.getElementById('wd-currency-label').textContent = wallet.currency === 'BTC' ? 'Bitcoin' : 'US Dollar';
  document.getElementById('wd-last-synced').textContent   = wallet.lastSynced ? fmtAgo(wallet.lastSynced) : 'never';
  document.getElementById('sel-method').value             = wallet.method ?? 'HIFO';

  const sm          = walletSm(wallet);
  const defaultFrom = taxYearStart(taxYear(now(), sm), sm);
  const defaultTo   = now();
  const taxEl       = document.getElementById('tax-results');
  taxEl.dataset.defaultFrom = dateStr(defaultFrom);
  taxEl.dataset.defaultTo   = dateStr(defaultTo);

  await refreshTaxResults(wallet);
}

async function refreshTaxResults(wallet) {
  const taxEl     = document.getElementById('tax-results');
  const loadingEl = document.getElementById('tax-loading');
  const errorEl   = document.getElementById('tax-error');
  const contentEl = document.getElementById('tax-content');
  if (!taxEl) return;

  // Preserve filter values across re-renders
  const fromVal = document.getElementById('inp-from')?.value ?? taxEl.dataset.defaultFrom ?? dateStr(taxYearStart(taxYear(now())));
  const toVal   = document.getElementById('inp-to')?.value   ?? taxEl.dataset.defaultTo   ?? dateStr(now());

  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  contentEl.classList.add('hidden');
  contentEl.innerHTML = '';

  let result;
  try {
    result = await calcWallet(wallet);
  } catch (e) {
    loadingEl.classList.add('hidden');
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
    return;
  }

  loadingEl.classList.add('hidden');

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
  const monthByYear = summariseByMonth(allDisposals, sm);

  contentEl.innerHTML = `
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
              const r  = summary[y];
              const mos = Object.keys(monthByYear[y] ?? {}).map(Number).sort((a, b) => {
                // Sort months in chronological order within the tax year
                const adjA = a < sm ? a + 12 : a;
                const adjB = b < sm ? b + 12 : b;
                return adjA - adjB;
              });
              const monthRows = mos.map(mo => {
                const mr = monthByYear[y][mo];
                return `<tr class="month-row" data-year="${y}" data-month="${mo}" style="cursor:pointer">
                  <td style="padding-left:32px"><span class="expand-arrow" style="font-size:10px;color:var(--text-muted);margin-right:6px">▶</span>${MONTHS[mo]}</td>
                  <td class="num muted">${mr.count}</td>
                  <td class="num">${ZAR(mr.proceeds)}</td>
                  <td class="num">${ZAR(mr.cost)}</td>
                  <td class="num ${mr.gain >= 0 ? 'gain-val' : 'loss-val'}">${ZAR(mr.gain)}</td>
                  <td class="num muted">${ZAR(mr.fees)}</td>
                </tr>
                <tr class="month-disposals-row hidden" data-year="${y}" data-month="${mo}">
                  <td colspan="6" style="padding:0;background:var(--bg)">
                    ${renderDisposalTable(mr.disposals, wallet, result)}
                  </td>
                </tr>`;
              }).join('');
              return `<tr class="year-row" data-year="${y}" style="cursor:pointer">
                <td><span class="expand-arrow" style="font-size:10px;color:var(--text-muted);margin-right:6px">▶</span><span class="year-label">${taxYearLabel(y)}</span></td>
                <td class="num muted">${r.count}</td>
                <td class="num">${ZAR(r.proceeds)}</td>
                <td class="num">${ZAR(r.cost)}</td>
                <td class="num ${r.gain >= 0 ? 'gain-val' : 'loss-val'}">${ZAR(r.gain)}</td>
                <td class="num muted">${ZAR(r.fees)}</td>
              </tr>
              <tr class="year-months-row hidden" data-year="${y}">
                <td colspan="6" style="padding:0">
                  <table class="tbl-yearly" style="border-top:none;margin:0">
                    <tbody>${monthRows}</tbody>
                  </table>
                </td>
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

  contentEl.classList.remove('hidden');

  // Tax year start month — persisted per wallet
  contentEl.querySelector('#sel-tax-month')?.addEventListener('change', async e => {
    wallet.taxYearStartMonth = parseInt(e.target.value, 10);
    await db.put('wallets', wallet);
    await refreshTaxResults(wallet);
  });

  // Show more / show all (Spending card)
  contentEl.querySelector('#btn-show-more')?.addEventListener('click', e => {
    contentEl.querySelectorAll('.disposal-extra').forEach(r => r.classList.remove('hidden'));
    e.target.closest('div').remove();
  });

  // Disposal date filters
  const isValidDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

  ['inp-from', 'inp-to'].forEach(id => {
    const text   = contentEl.querySelector(`#${id}`);
    if (!text) return;
    const wrap   = text.closest('.date-picker-wrap');
    const native = wrap.querySelector('.date-picker-native');
    const btn    = wrap.querySelector('.date-picker-btn');

    btn.addEventListener('click', () => native.showPicker?.() ?? native.click());

    native.addEventListener('change', () => {
      text.value = native.value;
      text.style.borderColor = '';
      refreshTaxResults(wallet);
    });

    text.addEventListener('change', () => {
      const valid = isValidDate(text.value);
      text.style.borderColor = valid ? '' : 'var(--loss)';
      if (valid) { native.value = text.value; refreshTaxResults(wallet); }
    });
  });

  // Year expand/collapse
  contentEl.querySelectorAll('.year-row').forEach(row => {
    row.addEventListener('click', () => {
      const y         = row.dataset.year;
      const monthsRow = contentEl.querySelector(`.year-months-row[data-year="${y}"]`);
      const arrow     = row.querySelector('.expand-arrow');
      const open      = !monthsRow.classList.contains('hidden');
      monthsRow.classList.toggle('hidden', open);
      arrow.textContent = open ? '▶' : '▼';
    });
  });

  // Month expand/collapse
  contentEl.querySelectorAll('.month-row').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      const { year, month }  = row.dataset;
      const disposalsRow     = contentEl.querySelector(`.month-disposals-row[data-year="${year}"][data-month="${month}"]`);
      const arrow            = row.querySelector('.expand-arrow');
      const open             = !disposalsRow.classList.contains('hidden');
      disposalsRow.classList.toggle('hidden', open);
      arrow.textContent = open ? '▶' : '▼';
    });
  });

  // Expand/collapse disposal rows (Spending card + all month expansion tables)
  contentEl.querySelectorAll('.disposal-row').forEach(row => {
    row.addEventListener('click', e => {
      e.stopPropagation();
      const idx   = row.dataset.idx;
      const group = row.closest('tbody').querySelector(`.lot-group[data-group="${idx}"]`);
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
  const isStep1 = addStep === 1;
  const isBlink = addStep === 2 && addType === 'blink';
  const isCsv   = addStep === 2 && addType === 'csv';

  document.getElementById('add-modal-title').textContent = isStep1 ? 'Add Account' : isBlink ? 'Connect Blink' : 'Upload CSV';

  document.getElementById('add-step-1').classList.toggle('hidden', !isStep1);
  document.getElementById('add-step-blink').classList.toggle('hidden', !isBlink);
  document.getElementById('add-step-csv').classList.toggle('hidden', !isCsv);
  document.getElementById('add-footer-1').classList.toggle('hidden', !isStep1);
  document.getElementById('add-footer-blink').classList.toggle('hidden', !isBlink);
  document.getElementById('add-footer-csv').classList.toggle('hidden', !isCsv);

  if (isStep1) {
    document.getElementById('add-name').value = addName;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === addType));
  }
  if (isBlink) {
    document.getElementById('add-apikey').value = '';
    document.getElementById('fetch-wallets-loading').classList.add('hidden');
    document.getElementById('fetch-wallets-error').classList.add('hidden');
    document.getElementById('fetch-wallets-warning').classList.add('hidden');
    document.getElementById('fetch-wallets-list').innerHTML = '';
    document.getElementById('btn-blink-save').classList.add('hidden');
  }
  if (isCsv) {
    document.getElementById('add-csv-file').value = '';
    document.getElementById('csv-preview-box').innerHTML = '';
    document.getElementById('csv-format-error').classList.add('hidden');
    document.getElementById('btn-csv-save').classList.add('hidden');
    addCsvRows = [];
  }
}

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parseTimestamp(raw) {
  const s = raw?.trim();
  if (!s) return NaN;

  // Pure integer — Unix timestamp. >1e11 is likely milliseconds, convert to seconds.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }

  // ISO 8601 and RFC 2822 — let the native parser handle (YYYY-MM-DD…)
  if (/^\d{4}[-\/]/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }

  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY  (day-first — SA standard)
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    let [, dd, mm, yy] = dmy.map(Number);
    if (yy < 100) yy += yy < 50 ? 2000 : 1900;
    const d = new Date(yy, mm - 1, dd);
    if (!isNaN(d.getTime()) && d.getDate() === dd && d.getMonth() === mm - 1)
      return Math.floor(d.getTime() / 1000);
    // Retry as MM/DD if day-first produced an invalid date (e.g. month > 12)
    const d2 = new Date(yy, dd - 1, mm);
    if (!isNaN(d2.getTime()) && d2.getMonth() === dd - 1)
      return Math.floor(d2.getTime() / 1000);
  }

  // YYYY/MM/DD or YYYY.MM.DD with slashes/dots
  const ymd = s.match(/^(\d{4})[\/\.](\d{1,2})[\/\.](\d{1,2})$/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (!isNaN(d.getTime()) && d.getMonth() === Number(ymd[2]) - 1)
      return Math.floor(d.getTime() / 1000);
  }

  // "15 Jan 2024" / "15 January 2024"
  const dMonY = s.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{2,4})$/i);
  if (dMonY) {
    const mon = MONTH_NAMES.indexOf(dMonY[2].toLowerCase().slice(0, 3));
    if (mon !== -1) {
      let yr = Number(dMonY[3]);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900;
      const d = new Date(yr, mon, Number(dMonY[1]));
      if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
  }

  // "Jan 15 2024" / "January 15, 2024" / "Jan 15, 2024"
  const monDY = s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{2,4})$/i);
  if (monDY) {
    const mon = MONTH_NAMES.indexOf(monDY[1].toLowerCase().slice(0, 3));
    if (mon !== -1) {
      let yr = Number(monDY[3]);
      if (yr < 100) yr += yr < 50 ? 2000 : 1900;
      const d = new Date(yr, mon, Number(monDY[2]));
      if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
  }

  // Last resort — let the browser try anything remaining
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);

  return NaN;
}

function parseAllCsvRows(text) {
  const lines = text.trim().split('\n');
  const header = lines[0]?.toLowerCase().replace(/\r/g, '');
  if (header !== 'id,time,amount,fee') return null;

  const valid = [], invalid = [];
  lines.slice(1).forEach((rawLine, i) => {
    const line = rawLine.replace(/\r/g, '');
    if (!line.trim()) return;
    const lineNum = i + 2;
    const parts   = line.split(',');

    // Need at least 4 parts. Allow extra commas inside the date field (e.g. "Jan 15, 2024")
    // by always treating the last two parts as amount and fee.
    if (parts.length < 4) {
      invalid.push({ lineNum, raw: line, reason: `expected 4 columns, got ${parts.length}` });
      return;
    }

    const id     = parts[0];
    const fee    = parts[parts.length - 1];
    const amount = parts[parts.length - 2];
    const time   = parts.slice(1, parts.length - 2).join(','); // re-joins if date had a comma

    const idTrimmed = id.trim();
    const timeNum   = parseTimestamp(time);
    const amountNum = Number(amount.trim());
    const feeNum    = Number(fee.trim());

    const errors = [];
    if (!idTrimmed)       errors.push('missing id');
    if (isNaN(timeNum))   errors.push('unrecognised date');
    if (isNaN(amountNum)) errors.push('invalid amount');
    if (isNaN(feeNum))    errors.push('invalid fee');

    if (errors.length) {
      invalid.push({ lineNum, raw: line, reason: errors.join(', ') });
    } else {
      valid.push({ id: idTrimmed, time: timeNum, amount: amountNum, fee: feeNum });
    }
  });

  return { valid, invalid };
}

function pickCsvFile(currency) {
  return new Promise(resolve => {
    const multipliers = { sats: 1, btc: 1e8, cents: 1, usd: 100 };
    let parsedValid = null;

    document.getElementById('pick-csv-units').innerHTML = currency === 'BTC'
      ? '<option value="sats">Satoshis</option><option value="btc">BTC</option>'
      : '<option value="cents">Cents</option><option value="usd">USD</option>';

    const fileInput  = document.getElementById('pick-csv-file');
    const previewEl  = document.getElementById('pick-csv-preview');
    const errEl      = document.getElementById('pick-csv-err');
    const okBtn      = document.getElementById('btn-csv-pick-ok');
    const cancelBtn  = document.getElementById('btn-csv-pick-cancel');
    const closeBtn   = document.getElementById('btn-csv-pick-close');

    fileInput.value  = '';
    previewEl.innerHTML = '';
    errEl.textContent   = '';

    openOverlay('overlay-csv-pick');

    const cleanup = val => {
      closeOverlay('overlay-csv-pick');
      fileInput.onchange = null;
      okBtn.onclick = cancelBtn.onclick = closeBtn.onclick = null;
      resolve(val);
    };

    fileInput.onchange = e => {
      parsedValid = null;
      previewEl.innerHTML = '';
      errEl.textContent   = '';
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = ev => {
        const result = parseAllCsvRows(ev.target.result);
        if (!result) {
          errEl.textContent = 'Invalid CSV. Expected header: id,time,amount,fee';
          return;
        }

        parsedValid = result.valid;

        let summary = `${result.valid.length} valid row${result.valid.length !== 1 ? 's' : ''}`;
        if (result.invalid.length) {
          summary += `, <span style="color:var(--loss)">${result.invalid.length} invalid (will be skipped)</span>`;
        }

        const invalidByLine = new Map(result.invalid.map(r => [r.lineNum, r.reason]));
        const dataLines = ev.target.result.trim().split('\n').slice(1).filter(l => l.trim());
        const sample    = dataLines.slice(0, 5);

        const rowsHtml = sample.map((rawLine, i) => {
          const lineNum = i + 2;
          const line    = rawLine.replace(/\r/g, '');
          const reason  = invalidByLine.get(lineNum);
          return reason
            ? `<div class="csv-preview-row invalid-row">Line ${lineNum}: ${line} — <em>${reason}</em></div>`
            : `<div class="csv-preview-row">${line}</div>`;
        }).join('');

        const more = dataLines.length > 5
          ? `<div class="csv-preview-row" style="color:var(--text-muted);font-style:italic">…${dataLines.length - 5} more rows</div>`
          : '';

        previewEl.innerHTML = `
          <div class="csv-preview" style="margin-top:10px">
            <div class="csv-preview-row header-row">id,time,amount,fee</div>
            ${rowsHtml}${more}
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:6px">${summary}</p>`;

        if (!result.valid.length) errEl.textContent = 'No valid rows found. Nothing to import.';
      };
      reader.readAsText(file);
    };

    cancelBtn.onclick = () => cleanup(null);
    closeBtn.onclick  = () => cleanup(null);

    okBtn.onclick = () => {
      if (!parsedValid) { errEl.textContent = 'Please select a valid CSV file.'; return; }
      if (!parsedValid.length) { errEl.textContent = 'No valid rows to import.'; return; }
      const multiplier = multipliers[document.getElementById('pick-csv-units').value];
      cleanup({ rows: parsedValid, multiplier });
    };
  });
}

function parseCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('csv-preview-box');
    const result  = parseAllCsvRows(e.target.result);

    if (!result) {
      document.getElementById('csv-format-error').classList.remove('hidden');
      document.getElementById('btn-csv-save').classList.add('hidden');
      addCsvRows = [];
      return;
    }
    document.getElementById('csv-format-error').classList.add('hidden');

    addCsvRows = result.valid;

    const invalidByLine = new Map(result.invalid.map(r => [r.lineNum, r.reason]));
    const dataLines = e.target.result.trim().split('\n').slice(1).filter(l => l.trim());
    const sample    = dataLines.slice(0, 5);

    const rowsHtml = sample.map((rawLine, i) => {
      const lineNum = i + 2;
      const line    = rawLine.replace(/\r/g, '');
      const reason  = invalidByLine.get(lineNum);
      return reason
        ? `<div class="csv-preview-row invalid-row">Line ${lineNum}: ${line} — <em>${reason}</em></div>`
        : `<div class="csv-preview-row">${line}</div>`;
    }).join('');

    const more    = dataLines.length > 5
      ? `<div class="csv-preview-row" style="color:var(--text-muted);font-style:italic">…${dataLines.length - 5} more rows</div>`
      : '';

    let summary = `${result.valid.length} valid row${result.valid.length !== 1 ? 's' : ''}`;
    if (result.invalid.length) summary += `, <span style="color:var(--loss)">${result.invalid.length} invalid (will be skipped)</span>`;

    preview.innerHTML = `
      <div class="csv-preview">
        <div class="csv-preview-row header-row">id,time,amount,fee</div>
        ${rowsHtml}${more}
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:6px">${summary}</p>`;

    if (result.valid.length > 0) {
      document.getElementById('btn-csv-save').classList.remove('hidden');
    } else {
      document.getElementById('btn-csv-save').classList.add('hidden');
    }
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

  const btcWallet = (wallets[accId] ?? []).find(w => w.currency === 'BTC') ?? wallets[accId]?.[0];
  if (btcWallet) {
    selectedWalletId = btcWallet.id;
    renderAccountList();
    await renderWalletDetail(btcWallet.id);
  }
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
  })).sort((a, b) => a.time - b.time || (a.amount >= 0 ? 0 : 1) - (b.amount >= 0 ? 0 : 1));
  await db.putMany('transactions', txEntries);

  closeOverlay('overlay-add-account');
  await loadAccounts();
  renderAccountList();

  const csvWallet = wallets[accId]?.[0];
  if (csvWallet) {
    selectedWalletId = csvWallet.id;
    renderAccountList();
    await renderWalletDetail(csvWallet.id);
  }
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

  // Back button in wallet detail
  document.querySelector('#wallet-detail .btn-back').addEventListener('click', () => {
    selectedWalletId = null;
    document.getElementById('wallet-detail').classList.add('hidden');
    document.getElementById('empty-detail').classList.remove('hidden');
    renderAccountList();
    expandSidebar();
  });

  // Wallet detail controls (wired once; look up current wallet via selectedWalletId at event time)
  document.getElementById('sel-method').addEventListener('change', async e => {
    const wallet = Object.values(wallets).flat().find(w => w.id === selectedWalletId);
    if (!wallet) return;
    wallet.method = e.target.value;
    await db.put('wallets', wallet);
    await refreshTaxResults(wallet);
  });

  document.getElementById('btn-refresh-wallet').addEventListener('click', async e => {
    const wallet  = Object.values(wallets).flat().find(w => w.id === selectedWalletId);
    const account = accounts.find(a => a.id === wallet?.accountId);
    if (!wallet) return;
    if (account?.type === 'csv') {
      const result = await pickCsvFile(wallet.currency);
      if (!result) return;
      const { rows, multiplier } = result;
      const entries = rows.map(r => ({
        _key: `${wallet.id}:${r.id}`, id: r.id, walletId: wallet.id,
        time: r.time, amount: Math.round(r.amount * multiplier), fee: Math.round(r.fee * multiplier),
      })).sort((a, b) => a.time - b.time || (a.amount >= 0 ? 0 : 1) - (b.amount >= 0 ? 0 : 1));
      await db.putMany('transactions', entries);
      wallet.lastSynced = now();
      await db.put('wallets', wallet);
      await renderWalletDetail(selectedWalletId);
    } else {
      e.target.textContent = '…'; e.target.disabled = true;
      try { await syncWallet(wallet, false); } catch (err) { console.warn(err); }
      e.target.textContent = '↻'; e.target.disabled = false;
      await renderWalletDetail(selectedWalletId);
    }
  });

  document.getElementById('btn-hard-refresh-wallet').addEventListener('click', async e => {
    const wallet  = Object.values(wallets).flat().find(w => w.id === selectedWalletId);
    const account = accounts.find(a => a.id === wallet?.accountId);
    if (!wallet) return;
    if (account?.type === 'csv') {
      const result = await pickCsvFile(wallet.currency);
      if (!result) return;
      const { rows, multiplier } = result;
      const existing = await db.getByIndex('transactions', 'walletId', wallet.id);
      if (!(await confirm(`Delete all ${existing.length} existing transactions for this wallet and replace with ${rows.length} from the new file?`))) return;
      const entries = rows.map(r => ({
        _key: `${wallet.id}:${r.id}`, id: r.id, walletId: wallet.id,
        time: r.time, amount: Math.round(r.amount * multiplier), fee: Math.round(r.fee * multiplier),
      })).sort((a, b) => a.time - b.time || (a.amount >= 0 ? 0 : 1) - (b.amount >= 0 ? 0 : 1));
      await db.deleteByIndex('transactions', 'walletId', wallet.id);
      await db.putMany('transactions', entries);
      wallet.lastSynced = now();
      await db.put('wallets', wallet);
      await renderWalletDetail(selectedWalletId);
    } else {
      if (!(await confirm('Delete all cached transactions for this wallet and re-fetch from scratch?'))) return;
      e.target.textContent = '…'; e.target.disabled = true;
      try { await syncWallet(wallet, true); } catch (err) { console.warn(err); }
      e.target.textContent = '⟳'; e.target.disabled = false;
      await renderWalletDetail(selectedWalletId);
    }
  });

  // Header buttons
  document.getElementById('btn-add-account').addEventListener('click', () => openAddAccountModal());
  document.getElementById('btn-add-first-account').addEventListener('click', () => openAddAccountModal());
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

  // Add account modal — wired once
  document.querySelectorAll('.type-btn').forEach(btn => btn.addEventListener('click', () => {
    addType = btn.dataset.type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === addType));
  }));
  document.getElementById('btn-add-cancel').addEventListener('click', () => closeOverlay('overlay-add-account'));
  document.getElementById('btn-close-add').addEventListener('click', () => closeOverlay('overlay-add-account'));
  document.getElementById('btn-add-next').addEventListener('click', () => {
    addName = document.getElementById('add-name').value.trim();
    if (!addName) { document.getElementById('add-name').focus(); return; }
    addStep = 2; renderAddStep();
  });
  document.getElementById('btn-add-back-blink').addEventListener('click', () => { addStep = 1; renderAddStep(); });
  document.getElementById('btn-add-back-csv').addEventListener('click', () => { addStep = 1; renderAddStep(); });
  document.getElementById('btn-fetch-wallets').addEventListener('click', async () => {
    const key = document.getElementById('add-apikey').value.trim();
    if (!key) return;
    document.getElementById('fetch-wallets-loading').classList.remove('hidden');
    document.getElementById('fetch-wallets-error').classList.add('hidden');
    document.getElementById('fetch-wallets-warning').classList.add('hidden');
    document.getElementById('fetch-wallets-list').innerHTML = '';
    document.getElementById('btn-blink-save').classList.add('hidden');
    try {
      const [wallets, scopes] = await Promise.all([
        fetchBlinkWallets(key),
        fetchBlinkAuthScopes(key),
      ]);
      addFetchedWallets = wallets;
      document.getElementById('fetch-wallets-loading').classList.add('hidden');
      document.getElementById('fetch-wallets-list').innerHTML = `
        <div class="wallet-fetch-list">
          ${addFetchedWallets.map(w => `
            <div class="wallet-fetch-item">
              <span class="wallet-currency-badge badge-${w.currency.toLowerCase()}">${w.currency === 'BTC' ? '₿' : '$'}</span>
              <span>${w.currency} Wallet</span>
            </div>`).join('')}
        </div>`;
      const extraScopes = scopes.filter(s => s === 'RECEIVE' || s === 'WRITE');
      if (extraScopes.length) {
        const warnEl = document.getElementById('fetch-wallets-warning');
        warnEl.textContent = `Warning: this key has ${extraScopes.join(' + ')} permission${extraScopes.length > 1 ? 's' : ''} in addition to READ. For security, use a READ-only key — generate one at dashboard.blink.sv.`;
        warnEl.classList.remove('hidden');
      }
      document.getElementById('btn-blink-save').classList.remove('hidden');
    } catch (e) {
      document.getElementById('fetch-wallets-loading').classList.add('hidden');
      document.getElementById('fetch-wallets-error').textContent = `Error: ${e.message}`;
      document.getElementById('fetch-wallets-error').classList.remove('hidden');
    }
  });
  document.getElementById('btn-blink-save').addEventListener('click', () => saveBlinkAccount());
  document.getElementById('add-denom').addEventListener('change', e => { addCsvDenom = e.target.value; });
  document.getElementById('add-csv-file').addEventListener('change', e => parseCsvFile(e.target.files[0]));
  document.getElementById('btn-csv-save').addEventListener('click', () => saveCsvAccount());

  // Welcome modal
  document.getElementById('chk-agree').addEventListener('change', e => {
    document.getElementById('btn-continue').disabled = !e.target.checked;
  });
  document.getElementById('btn-continue').addEventListener('click', () => {
    localStorage.setItem('termsAccepted', '1');
    closeOverlay('overlay-welcome');
  });
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
