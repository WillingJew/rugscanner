// RugScanner Pro — Content Script v8
// Scroll all visible rows, find funder address in each row, count matches

const BACKEND_URL = 'https://rugscanner-production-1a92.up.railway.app';
window.__rugScannerLoaded = true;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getTokenCA() {
  try {
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.href.includes('pump.fun/coin/') || a.href.includes('solscan.io/token/')) {
        const m = a.href.match(/\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
        if (m) return m[1];
      }
    }
  } catch(e) {}
  const m = window.location.pathname.match(/\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/|$)/);
  return m ? m[1] : null;
}

function getFiberKey(el) {
  return Object.keys(el).find(k => k.startsWith('__reactFiber'));
}

function getFiberAddress(el) {
  const fk = getFiberKey(el);
  if (!fk) return null;
  let f = el[fk];
  for (let i = 0; i < 10; i++) {
    if (f?.memoizedProps?.address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.memoizedProps.address))
      return f.memoizedProps.address;
    f = f?.return;
  }
  return null;
}

function getLPAddress() {
  const liqEl = Array.from(document.querySelectorAll('*'))
    .find(el => el.childElementCount === 0 && el.textContent.trim() === 'LIQ POOL');
  if (!liqEl) return null;
  let el = liqEl;
  for (let i = 0; i < 12; i++) {
    const addr = getFiberAddress(el);
    if (addr) return addr;
    el = el.parentElement;
    if (!el) break;
  }
  return null;
}

async function ensureHoldersTab() {
  const btn = Array.from(document.querySelectorAll('button, div'))
    .find(el => /^Holders(\s*\(\d+\))?$/.test(el.textContent?.trim()));
  if (!btn) return;
  const isActive = btn.style.color === 'rgb(255, 255, 255)' ||
    btn.className?.includes('active') ||
    btn.getAttribute('aria-selected') === 'true';
  if (!isActive) { btn.click(); await sleep(1000); }
}

// Truncated address pattern: "XXXX…XXXX" using unicode ellipsis or dots
const isTruncAddr = s => /^[A-Za-z0-9]{2,8}[\u2026\.]{1,3}[A-Za-z0-9]{2,8}$/.test(s);

// Get funder from a row's lines — just find the FIRST truncated address
// that isn't the holder's own address (which is always lines[1])
function getFunderFromLines(lines) {
  const holderAddr = lines[1]; // e.g. "A9hX…sWJ"
  for (let i = 2; i < lines.length; i++) {
    if (isTruncAddr(lines[i]) && lines[i] !== holderAddr) {
      return lines[i];
    }
  }
  return null;
}

async function scrapeData() {
  const container = Array.from(document.querySelectorAll('.padre-no-scroll'))
    .filter(el => el.className.trim() === 'padre-no-scroll')[0];
  if (!container) return { funderCounts: {}, totalRows: 0 };

  const firstRow = Array.from(document.querySelectorAll('*')).find(el => el.className?.includes?.('css-1vec7k8'));
  const fk = firstRow ? getFiberKey(firstRow) : null;
  if (!fk) return { funderCounts: {}, totalRows: 0 };

  const funderCounts = {};
  const seenRanks = new Set();
  let clockIconCount = 0;
  let maxClockNumber = 0;
  const clockRanks = new Set(); // track which ranks had clock icons

  function readRows() {
    const rows = Array.from(document.querySelectorAll('*')).filter(el => el.className?.includes?.('css-1vec7k8'));
    for (const el of rows) {
      let f = el[fk], rank = null;
      for (let i = 0; i < 8; i++) {
        if (f?.memoizedProps?.address) { rank = Math.abs(f.memoizedProps.rank); break; }
        f = f?.return;
      }
      if (!rank || rank <= 0 || seenRanks.has(rank)) continue;
      seenRanks.add(rank);

      const lines = (el.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      if (lines[1] === 'LIQ POOL') continue;

      const funder = getFunderFromLines(lines);
      if (funder) funderCounts[funder] = (funderCounts[funder] || 0) + 1;

      // Clock badge detection — find SVGs with the clock path inside this row
      if (!clockRanks.has(rank)) {
        const svgs = el.querySelectorAll('svg');
        for (const svg of svgs) {
          const path = svg.querySelector('path[d*="M12 8V12L14.5 14.5"]');
          if (!path) continue;
          // Found clock icon — get the number from parent span's text
          const parent = svg.closest('span') || svg.parentElement;
          const num = parseInt((parent?.textContent || '').replace(/\D/g, ''), 10);
          if (num > 0) {
            clockRanks.add(rank);
            clockIconCount++;
            if (num > maxClockNumber) maxClockNumber = num;
          }
          break;
        }
      }
    }
  }

  container.scrollTop = 0;
  await sleep(400);

  const stepSize = Math.floor(container.clientHeight * 0.5);
  let pos = 0, passes = 0;

  while (passes < 60) {
    readRows();
    if (pos >= container.scrollHeight - container.clientHeight - 5) break;
    pos = Math.min(pos + stepSize, container.scrollHeight);
    container.scrollTop = pos;
    await sleep(150);
    passes++;
  }
  readRows();
  container.scrollTop = 0;

  const totalRows = seenRanks.size;
  console.log(`[RugScanner] Scraped ${totalRows} rows | clock icons: ${clockIconCount} | max clock: ${maxClockNumber} | funders:`, JSON.stringify(funderCounts));
  return { funderCounts, totalRows, clockIconCount, maxClockNumber };
}

async function runScan(authToken, mode) {
  const ca = getTokenCA();
  if (!ca) throw new Error('Could not detect token CA — are you on a token page?');
  console.log('[RugScanner] CA:', ca);

  await ensureHoldersTab();
  await sleep(500);

  const lpAddress = getLPAddress();
  const { funderCounts, totalRows, clockIconCount, maxClockNumber } = await scrapeData();

  console.log('[RugScanner] LP:', lpAddress || 'not found');

  const response = await fetch(`${BACKEND_URL}/analyze-scraped`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    body: JSON.stringify({ ca, lpAddress, funderCounts, totalRows, clockIconCount, maxClockNumber, mode, source: 'padre_v9' }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 403) throw new Error('PRO subscription required');
    throw new Error(`Server error ${response.status}: ${errText}`);
  }

  return await response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_TOKEN') {
    runScan(message.authToken, message.mode || 'quick')
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === 'PING') sendResponse({ pong: true });
});

console.log('[RugScanner] Content script v9 loaded');
