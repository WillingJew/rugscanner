// RugScanner Pro - Server-side padre.gg scraper
// Runs headless on Railway — user never sees it

let puppeteer;
try {
  puppeteer = require('puppeteer');
  console.log('[Scraper] Puppeteer loaded OK');
} catch (err) {
  console.error('[Scraper] Failed to load Puppeteer:', err.message);
}

async function scrapePadre(mintAddress) {
  if (!puppeteer) {
    console.error('[Scraper] Puppeteer not available — skipping scrape');
    return [];
  }
  let browser = null;
  console.log('[Scraper] Starting for', mintAddress);

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--memory-pressure-off',
      ],
      timeout: 60000,
      protocolTimeout: 60000,
    });
    await new Promise(r => setTimeout(r, 1000)); // Let Chrome initialize

    const page = await browser.newPage();

    // Block unnecessary resources for speed
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    // Navigate to coin page
    const url = `https://trade.padre.gg/sol/${mintAddress}`;
    console.log('[Scraper] Loading', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Wait for holder table
    await new Promise(r => setTimeout(r, 3000));

    // Click Holders tab if needed
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, [role="tab"], div[class*="tab"]'));
      const holdersTab = tabs.find(t => t.innerText?.trim().startsWith('Holders'));
      if (holdersTab) holdersTab.click();
    });

    await new Promise(r => setTimeout(r, 2000));

    // Scroll holder table to load rows
    await page.evaluate(async () => {
      const container = Array.from(document.querySelectorAll('div')).find(d =>
        (d.innerText || '').includes('Funded By') &&
        d.scrollHeight > d.clientHeight + 10
      );
      if (!container) return;
      for (let i = 0; i < 8; i++) {
        container.scrollTop += 200;
        await new Promise(r => setTimeout(r, 150));
      }
      container.scrollTop = 0;
      await new Promise(r => setTimeout(r, 500));
    });

    // Scrape holder rows
    const holderData = await page.evaluate(() => {
      const LEAF_PATH   = 'M20.998 3V5C20.998 14.6274';
      const BUNDLE_PATH = 'M20.0833 15.1999';

      const results = [];
      const seen = new Set();

      const allDivs = Array.from(document.querySelectorAll('div'));

      for (const div of allDivs) {
        const text = (div.innerText || '').replace(/\s+/g, ' ').trim();

        // Must start with a rank number and contain %
        if (!/^\d+\s/.test(text) || !text.includes('%') || text.length < 25) continue;

        const rankMatch = text.match(/^(\d+)\s/);
        if (!rankMatch) continue;
        const rank = parseInt(rankMatch[1]);
        if (rank > 25 || seen.has(rank)) continue;

        // Skip header rows
        if (text.includes('Rank') && text.includes('Address') && text.includes('Balance')) continue;

        seen.add(rank);

        // LP detection
        const isLP = text.toLowerCase().includes('liq pool') ||
                     text.toLowerCase().includes('liq\u00a0pool');

        // Leaf icon detection via SVG path fingerprint
        const svgs = Array.from(div.querySelectorAll('svg'));
        let hasLeaf = false;
        let hasBundle = false;
        for (const svg of svgs) {
          const path = svg.querySelector('path');
          const d = path?.getAttribute('d') || '';
          if (d.startsWith(LEAF_PATH)) hasLeaf = true;
          if (d.startsWith(BUNDLE_PATH)) hasBundle = true;
        }

        // Software detection
        let software = 'unknown';
        const SOFTWARE = {
          photon: ['photon'], axiom: ['axiom'], terminal: ['terminal'],
          coinbase: ['coinbase'], bullx: ['bullx'], gmgn: ['gmgn'],
          trojan: ['trojan'], bitget: ['bitget'], binance: ['binance'],
          mexc: ['mexc'], robinhood: ['robinhood'],
        };
        const html = (div.innerHTML || '').toLowerCase();
        for (const [name, patterns] of Object.entries(SOFTWARE)) {
          if (patterns.some(p => html.includes(p))) { software = name; break; }
        }

        // Funder address — second truncated base58 address in the row
        const addrPattern = /\b([1-9A-HJ-NP-Za-km-z]{4,8}\.{2,3}[1-9A-HJ-NP-Za-km-z]{2,5})\b/g;
        const allAddrs = [...text.matchAll(addrPattern)]
          .map(m => m[1])
          .filter(addr => {
            const prefix = addr.split('.')[0];
            return /\d/.test(prefix) || (prefix !== prefix.toLowerCase() && prefix !== prefix.toUpperCase());
          });
        const funderAddress = allAddrs.length >= 2 ? allAddrs[1] : null;

        // Clock number — the number before the funder address
        let clockNumber = null;
        if (funderAddress) {
          const addrIdx = text.indexOf(funderAddress.slice(0, 4));
          if (addrIdx > 0) {
            const before = text.slice(Math.max(0, addrIdx - 15), addrIdx).trim();
            const numMatch = before.match(/(\d{1,3})\s*$/);
            if (numMatch) clockNumber = parseInt(numMatch[1]);
          }
        }

        // Leaf age from tooltip
        let leafAge = null;
        const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]'));
        for (const t of tooltips) {
          const txt = (t.innerText || '').toLowerCase();
          if (txt.includes('had 0 sol') || txt.includes('0 sol until')) {
            const m = txt.match(/(\d+)\s*(s|m|h|d)\s*ago/i);
            if (m) {
              const v = parseInt(m[1]);
              const u = m[2].toLowerCase();
              leafAge = u === 's' ? v : u === 'm' ? v*60 : u === 'h' ? v*3600 : v*86400;
            }
          }
        }

        results.push({ rank, isLP, hasLeaf, hasBundle, software, funderAddress, clockNumber, leafAge });
      }

      return results.sort((a, b) => a.rank - b.rank);
    });

    console.log('[Scraper] Got', holderData.length, 'rows');
    return holderData;

  } catch (err) {
    console.error('[Scraper] Failed:', err.message);
    return [];
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { scrapePadre };
