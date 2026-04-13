// RugScanner Pro — Padre.gg Content Script v4
// Confirmed working approach from live DOM investigation:
//   - Holder rows use class css-1vec7k8
//   - LP row uses class css-1kujlje with "LIQ POOL" text
//   - Full addresses are in React fiber memoizedProps.address
//   - Row structure parsed from document.body.innerText
//   - Percentages calculated from balance / totalBalance
//   - Scrollable container has class "padre-no-scroll" (plain, no extra classes)

const BACKEND_URL = 'https://your-railway-app.railway.app'; // TODO: replace

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Get token CA from URL ─────────────────────────────────────────────────────
function getTokenCA() {
  const match = window.location.pathname.match(/\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/|$)/);
  return match ? match[1] : null;
}

// ── Get React fiber key for any element ──────────────────────────────────────
function getFiberKey(el) {
  return Object.keys(el).find(k => k.startsWith('__reactFiber'));
}

// ── Walk fiber tree upward to find address prop ───────────────────────────────
function getFiberAddress(el) {
  const fk = getFiberKey(el);
  if (!fk) return null;
  let f = el[fk];
  for (let i = 0; i < 8; i++) {
    if (f?.memoizedProps?.address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.memoizedProps.address)) {
      return { address: f.memoizedProps.address, rank: Math.abs(f.memoizedProps.rank) };
    }
    f = f?.return;
  }
  return null;
}

// ── Find the holder list scroll container ────────────────────────────────────
function findScrollContainer() {
  // The holders list uses a plain .padre-no-scroll div (no extra MUI classes)
  return Array.from(document.querySelectorAll('.padre-no-scroll'))
    .filter(el => el.className.trim() === 'padre-no-scroll')[0] || null;
}

// ── Ensure Holders tab is active ──────────────────────────────────────────────
async function ensureHoldersTab() {
  const all = Array.from(document.querySelectorAll('button, div'));
  const btn = all.find(el => /^Holders(\s*\(\d+\))?$/.test(el.textContent?.trim()));
  if (!btn) throw new Error('Holders tab not found');
  const isActive = btn.style.color === 'rgb(255, 255, 255)' ||
    btn.className?.includes('active') ||
    btn.getAttribute('aria-selected') === 'true';
  if (!isActive) { btn.click(); await sleep(1000); }
}

// ── Extract addresses from currently visible holder rows ──────────────────────
function extractVisibleAddresses() {
  const map = {}; // rank -> address

  // Regular holder rows (css-1vec7k8)
  const rows = Array.from(document.querySelectorAll('*'))
    .filter(el => el.className?.includes?.('css-1vec7k8'));
  for (const el of rows) {
    const data = getFiberAddress(el);
    if (data && data.rank > 0) map[data.rank] = data.address;
  }

  return map;
}

// ── Get LP address from the LIQ POOL row ─────────────────────────────────────
function getLPAddress() {
  const all = Array.from(document.querySelectorAll('*'));
  // Find the element that displays "LIQ POOL" text
  const liqEl = all.find(el => el.childElementCount === 0 && el.textContent.trim() === 'LIQ POOL');
  if (!liqEl) return null;

  // Walk up to find fiber with address (LP uses css-1kujlje container)
  let el = liqEl;
  for (let i = 0; i < 10; i++) {
    const data = getFiberAddress(el);
    if (data) return data.address;
    el = el.parentElement;
    if (!el) break;
  }
  return null;
}

// ── Parse innerText for row structure ────────────────────────────────────────
// Each row in innerText: rank → truncAddr → balance → ...
// Detection: a line matching /^\d+$/ followed by a truncated address or "LIQ POOL"
function parseHolderRows() {
  const text = document.body.innerText;
  const headerIdx = text.indexOf('Rank\nAddress\nBalance');
  if (headerIdx === -1) return null;

  let endIdx = text.indexOf('\nInvested\n', headerIdx);
  if (endIdx === -1) endIdx = text.indexOf('\nP1\nP2\nP3\n', headerIdx);
  if (endIdx === -1) endIdx = headerIdx + 8000;

  const lines = text.slice(headerIdx, endIdx).split('\n').map(l => l.trim()).filter(Boolean);

  const isRank = s => /^\d+$/.test(s) && +s > 0 && +s < 500;
  const isAddr = s => /^[A-Za-z0-9]{2,6}[…\.]{1,3}[A-Za-z0-9]{2,6}$/.test(s) || s === 'LIQ POOL';

  const rowStarts = [];
  for (let i = 1; i < lines.length - 1; i++) {
    if (isRank(lines[i]) && isAddr(lines[i + 1])) rowStarts.push(i);
  }

  return rowStarts.map(start => ({
    rank: +lines[start],
    isLP: lines[start + 1] === 'LIQ POOL',
    balance: parseFloat(lines[start + 2]?.replace(/,/g, '')) || 0,
  }));
}

// ── Main scrape ───────────────────────────────────────────────────────────────
async function scrapeHolders() {
  await ensureHoldersTab();
  await sleep(800);

  const container = findScrollContainer();
  if (!container) throw new Error('Holder list scroll container not found');

  // Scroll to top
  container.scrollTop = 0;
  await sleep(500);

  // Collect LP address while rank 1-5 are visible
  let lpAddress = getLPAddress();
  if (lpAddress) console.log('[RugScanner] LP address captured at top:', lpAddress);

  // Scroll through entire list collecting fiber addresses
  const addressMap = {};
  const stepSize = Math.floor(container.clientHeight * 0.55);
  let pos = 0, passes = 0;

  console.log('[RugScanner] Scanning holders...');

  while (passes < 60) {
    Object.assign(addressMap, extractVisibleAddresses());
    // Also retry LP capture in case it wasn't visible at top
    if (!lpAddress) lpAddress = getLPAddress();

    const atBottom = pos >= container.scrollHeight - container.clientHeight - 5;
    if (atBottom) break;

    pos = Math.min(pos + stepSize, container.scrollHeight);
    container.scrollTop = pos;
    await sleep(200);
    passes++;
  }
  // Final extract at bottom
  Object.assign(addressMap, extractVisibleAddresses());
  if (!lpAddress) lpAddress = getLPAddress();

  // Scroll back to top for innerText parse (innerText reflects visible content)
  container.scrollTop = 0;
  await sleep(500);

  // Parse row structure from innerText (now showing top rows)
  const rows = parseHolderRows();
  if (!rows || rows.length === 0) {
    throw new Error('Could not parse holder rows — is the Holders tab visible?');
  }

  console.log(`[RugScanner] Parsed ${rows.length} rows | Addresses: ${Object.keys(addressMap).length} | LP: ${lpAddress || 'not found'}`);

  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);
  const holders = [];

  for (const row of rows) {
    if (row.isLP) {
      if (!lpAddress) lpAddress = addressMap[row.rank] || null;
      continue;
    }
    holders.push({
      rank: row.rank,
      address: addressMap[row.rank] || `unknown_rank_${row.rank}`,
      percentage: totalBalance > 0 ? Math.round(row.balance / totalBalance * 10000) / 100 : 0,
      balance: row.balance,
      isLP: false,
      funder: null,
    });
  }

  // Re-rank sequentially
  holders.sort((a, b) => a.rank - b.rank);
  holders.forEach((h, i) => { h.rank = i + 1; });

  return { holders, lpAddress, holderCount: rows.length };
}

// ── Run scan ──────────────────────────────────────────────────────────────────
async function runScan(authToken) {
  const ca = getTokenCA();
  if (!ca) throw new Error('Could not detect token CA — are you on a token page?');
  console.log('[RugScanner] Scanning CA:', ca);

  const { holders, lpAddress, holderCount } = await scrapeHolders();
  if (holders.length === 0) throw new Error('No holders found');

  const response = await fetch(`${BACKEND_URL}/analyze-scraped`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    body: JSON.stringify({ ca, lpAddress, holders, holderCount, source: 'padre_scrape_v4' }),
  });

  if (!response.ok) throw new Error(`Backend error ${response.status}: ${await response.text()}`);
  return await response.json();
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_TOKEN') {
    runScan(message.authToken)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === 'GET_CA') sendResponse({ ca: getTokenCA() });
});

console.log('[RugScanner] Content script v4 loaded');
