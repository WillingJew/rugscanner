// RugScanner Pro - Headless scraper for padre.gg funded-by data
// Runs server-side via Puppeteer — user never sees it

const puppeteer = require('puppeteer');

const PADRE_URL = 'https://trade.padre.gg';

// Known LP/pool address patterns to skip
const LP_PATTERNS = ['liq pool', 'liq\u00a0pool', 'liquidity'];

async function scrapeFundedBy(mintAddress) {
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
      ]
    });

    const page = await browser.newPage();

    // Block images, fonts, media to speed up load
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to the coin page
    const url = `${PADRE_URL}/sol/${mintAddress}`;
    console.log(`[Scraper] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for holders tab to appear
    await page.waitForSelector('[class*="Holder"], [class*="holder"]', { timeout: 15000 })
      .catch(() => console.log('[Scraper] Holder selector timeout — proceeding anyway'));

    // Click on Holders tab if not already active
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const holdersTab = tabs.find(t => t.innerText?.includes('Holders'));
      if (holdersTab) holdersTab.click();
    });

    await new Promise(r => setTimeout(r, 2000));

    // Scroll the holder table to load all rows
    await page.evaluate(async () => {
      const container = Array.from(document.querySelectorAll('div')).find(d =>
        d.innerText?.includes('Rank') &&
        d.innerText?.includes('Funded By') &&
        d.scrollHeight > d.clientHeight
      );
      if (!container) return;
      for (let i = 0; i < 5; i++) {
        container.scrollTop += 300;
        await new Promise(r => setTimeout(r, 200));
      }
      container.scrollTop = 0;
    });

    await new Promise(r => setTimeout(r, 1000));

    // Extract funded-by data from the DOM
    const holderData = await page.evaluate(() => {
      const results = [];

      // Find all holder rows
      const allDivs = Array.from(document.querySelectorAll('div'));
      const rows = allDivs.filter(div => {
        const t = div.innerText?.trim() || '';
        return /^\d+\s/.test(t) && t.includes('%') && t.length > 30;
      });

      for (const row of rows.slice(0, 26)) {
        const text = row.innerText?.trim() || '';
        const rankMatch = text.match(/^(\d+)\s/);
        if (!rankMatch) continue;
        const rank = parseInt(rankMatch[1]);
        if (rank > 25) continue;

        // Skip LP row
        if (text.toLowerCase().includes('liq pool') ||
            text.toLowerCase().includes('liq\u00a0pool')) {
          results.push({ rank, isLP: true, funderAddress: null, clockNumber: null });
          continue;
        }

        // Extract funded-by address from the last column
        // Pattern: truncated address like "Ab3x...kW9"
        const addrPattern = /\b([1-9A-HJ-NP-Za-km-z]{4,8}\.{2,3}[1-9A-HJ-NP-Za-km-z]{2,5})\b/g;
        const allAddrs = [...text.matchAll(addrPattern)]
          .map(m => m[1])
          .filter(addr => {
            const prefix = addr.split('.')[0];
            return /\d/.test(prefix) || (prefix !== prefix.toLowerCase() && prefix !== prefix.toUpperCase());
          });

        // First address = holder wallet, second = funder
        const funderAddress = allAddrs.length >= 2 ? allAddrs[1] : null;

        // Extract clock number (the number before the funder address)
        let clockNumber = null;
        if (funderAddress) {
          const addrIdx = text.indexOf(funderAddress.slice(0, 4));
          if (addrIdx > 0) {
            const before = text.slice(Math.max(0, addrIdx - 15), addrIdx).trim();
            const numMatch = before.match(/(\d{1,3})\s*$/);
            if (numMatch) clockNumber = parseInt(numMatch[1]);
          }
        }

        results.push({ rank, isLP: false, funderAddress, clockNumber });
      }

      return results;
    });

    console.log(`[Scraper] Got ${holderData.length} rows`);
    return holderData;

  } catch (err) {
    console.error('[Scraper] Error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeFundedBy };
