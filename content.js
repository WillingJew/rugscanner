// RugScanner Pro — Padre.gg Content Script
// Scrapes the holders table, identifies LP by "LIQ POOL" label,
// sends clean holder data to the backend for analysis.

const BACKEND_URL = 'https://your-railway-app.railway.app'; // TODO: replace with your Railway URL
const CHECK_INTERVAL_MS = 500;
const MAX_WAIT_MS = 10000;

// ── Utility: wait for a DOM element to appear ────────────────────────────────
function waitForElement(selector, maxMs = MAX_WAIT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - start > maxMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for: ${selector}`));
      }
    }, CHECK_INTERVAL_MS);
  });
}

// ── Utility: wait for condition ───────────────────────────────────────────────
function waitForCondition(fn, maxMs = MAX_WAIT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const result = fn();
      if (result) {
        clearInterval(interval);
        resolve(result);
      } else if (Date.now() - start > maxMs) {
        clearInterval(interval);
        reject(new Error('Condition timed out'));
      }
    }, CHECK_INTERVAL_MS);
  });
}

// ── Extract token CA from the current URL or page ────────────────────────────
function getTokenCA() {
  // padre.gg URL format: trade.padre.gg/TOKEN_CA or similar
  const url = window.location.href;

  // Try URL path first
  const pathMatch = url.match(/\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/);
  if (pathMatch) return pathMatch[1];

  // Try CA element on page (right sidebar shows "CA: ...")
  const caEl = document.querySelector('[class*="ca"]');
  if (caEl) {
    const match = caEl.textContent.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match) return match[1];
  }

  return null;
}

// ── Click the Holders tab if not already active ───────────────────────────────
async function ensureHoldersTabActive() {
  // Find all tab buttons and look for one containing "Holders"
  const tabs = document.querySelectorAll('button, [role="tab"], .tab, [class*="tab"]');
  let holdersTab = null;

  for (const tab of tabs) {
    if (tab.textContent.trim().match(/^Holders/i)) {
      holdersTab = tab;
      break;
    }
  }

  if (!holdersTab) {
    throw new Error('Could not find Holders tab');
  }

  // Check if already active — look for active class or aria-selected
  const isActive = holdersTab.classList.contains('active') ||
    holdersTab.getAttribute('aria-selected') === 'true' ||
    holdersTab.classList.contains('selected') ||
    holdersTab.style.color === 'rgb(255, 255, 255)';

  if (!isActive) {
    console.log('[RugScanner] Clicking Holders tab...');
    holdersTab.click();
    // Wait for table rows to appear
    await new Promise(r => setTimeout(r, 800));
  }
}

// ── Scrape the holders table ──────────────────────────────────────────────────
function scrapeHoldersTable() {
  const holders = [];
  let lpAddress = null;

  // Find table rows — padre uses a virtualized list or standard table
  // Try standard table rows first
  let rows = document.querySelectorAll('table tbody tr, [class*="holder-row"], [class*="holderRow"]');

  // Fallback: find rows by structure (rank number in first cell)
  if (!rows || rows.length === 0) {
    rows = document.querySelectorAll('[class*="row"]:not([class*="header"])');
  }

  if (!rows || rows.length === 0) {
    throw new Error('No holder rows found in DOM');
  }

  console.log(`[RugScanner] Found ${rows.length} rows`);

  for (const row of rows) {
    const text = row.textContent || '';

    // Skip header rows
    if (text.includes('Rank') && text.includes('Address') && text.includes('Balance')) continue;
    if (text.trim().length < 5) continue;

    // Extract rank — first number in the row
    const rankMatch = text.match(/^[\s]*(\d+)/);
    const rank = rankMatch ? parseInt(rankMatch[1]) : null;
    if (!rank || rank > 200) continue;

    // Detect LIQ POOL label
    const isLP = text.includes('LIQ POOL') || text.includes('LIQ_POOL') || text.includes('LIQPOOL');

    // Extract wallet address — 32-44 char base58 string
    // Padre shows truncated addresses like "7CtW_Hb4" — we need the full address
    // Look for a data attribute or full address in child elements
    let address = null;

    // Try data attributes first (padre often stores full address here)
    const addrEl = row.querySelector('[data-address], [data-wallet], [title]');
    if (addrEl) {
      const candidate = addrEl.getAttribute('data-address') ||
        addrEl.getAttribute('data-wallet') ||
        addrEl.getAttribute('title') || '';
      if (candidate.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
        address = candidate;
      }
    }

    // Fallback: scan all text nodes for a full base58 address
    if (!address) {
      const allText = row.innerHTML;
      const addrMatch = allText.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
      if (addrMatch) {
        // Filter out known non-address strings (program IDs we don't care about)
        address = addrMatch.find(a => a.length >= 32 && a.length <= 44) || null;
      }
    }

    // Extract percentage from the "Remaining" column
    // Padre shows it as "$ X | Y%" format in the remaining column
    let percentage = null;
    const pctMatch = text.match(/(\d+\.?\d*)\s*%/);
    if (pctMatch) {
      percentage = parseFloat(pctMatch[1]);
    }

    // Extract balance
    let balance = null;
    const balMatch = text.match(/≡\s*([\d,.]+)/);
    if (balMatch) {
      balance = parseFloat(balMatch[1].replace(',', ''));
    }

    if (isLP) {
      lpAddress = address;
      console.log(`[RugScanner] LP found at rank ${rank}: ${address}`);
      continue; // Don't add LP to holders array
    }

    if (rank && percentage !== null) {
      holders.push({
        rank,
        address: address || `unknown_${rank}`,
        percentage,
        balance,
        isLP: false,
        funder: null,
      });
    }
  }

  return { holders, lpAddress };
}

// ── Main scan function — called when user triggers scan ───────────────────────
async function runScan(authToken) {
  console.log('[RugScanner] Starting scan...');

  const ca = getTokenCA();
  if (!ca) throw new Error('Could not detect token CA from this page');
  console.log('[RugScanner] Token CA:', ca);

  // Make sure holders tab is visible
  await ensureHoldersTabActive();

  // Wait for rows to populate
  await waitForCondition(() => {
    const rows = document.querySelectorAll('table tbody tr, [class*="holder-row"], [class*="holderRow"]');
    return rows && rows.length > 3;
  });

  // Scrape the table
  const { holders, lpAddress } = scrapeHoldersTable();
  console.log(`[RugScanner] Scraped ${holders.length} holders, LP: ${lpAddress}`);

  if (holders.length === 0) {
    throw new Error('No holders found — try clicking the Holders tab manually first');
  }

  // Send to backend
  const response = await fetch(`${BACKEND_URL}/analyze-scraped`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      ca,
      lpAddress,
      holders,
      holderCount: holders.length,
      source: 'padre_scrape',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Backend error: ${err}`);
  }

  return await response.json();
}

// ── Message listener — receives commands from popup/background ────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCAN_TOKEN') {
    runScan(message.authToken)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_CA') {
    const ca = getTokenCA();
    sendResponse({ ca });
  }
});

console.log('[RugScanner] Content script loaded on', window.location.href);
