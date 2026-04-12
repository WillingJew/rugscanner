// test.js — Run locally to validate LP detection and scoring
// Usage: node test.js
// Requires .env with HELIUS_API_KEY or HELIUS_RPC_URL

require('dotenv').config();
const { analyzeToken, enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');

// ── Test tokens — replace with CAs you know the ground truth on ──────────────
// Add tokens where you KNOW the outcome: clean, bundled, rugged, etc.
const TEST_TOKENS = [
  {
    ca: 'PASTE_A_KNOWN_BUNDLED_TOKEN_CA_HERE',
    label: 'Known bundle',
    expectedNoBuy: true,
  },
  {
    ca: 'PASTE_A_KNOWN_CLEAN_TOKEN_CA_HERE',
    label: 'Known clean',
    expectedNoBuy: false,
  },
  // Add more as you find them
];

// ── ANSI colors for terminal output ─────────────────────────────────────────
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function colorScore(score) {
  if (score >= 65) return `${RED}${score}${RESET}`;
  if (score >= 40) return `${YELLOW}${score}${RESET}`;
  return `${GREEN}${score}${RESET}`;
}

async function testToken({ ca, label, expectedNoBuy }) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${BOLD}${CYAN}Testing: ${label}${RESET}`);
  console.log(`CA: ${ca}`);
  console.log('─'.repeat(60));

  try {
    const start = Date.now();

    // Step 1: Fetch raw data
    const tokenData = await analyzeToken(ca);

    // Step 2: Log LP detection results
    const lps = tokenData.holders.filter(h => h.isLP);
    const real = tokenData.holders.filter(h => !h.isLP);
    console.log(`\n${BOLD}LP Detection:${RESET}`);
    if (lps.length === 0) {
      console.log(`  ${YELLOW}⚠ No LP detected${RESET}`);
    } else {
      lps.forEach(lp => {
        console.log(`  ${GREEN}✓ LP found${RESET}: ${lp.short} | ${lp.percentage.toFixed(2)}% | owner program: ${lp.program?.slice(0,8)}...`);
      });
    }

    // Step 3: Show top 10 real holders
    console.log(`\n${BOLD}Top 10 Real Holders:${RESET}`);
    real.slice(0, 10).forEach(h => {
      console.log(`  #${h.rank} ${h.short} — ${h.percentage.toFixed(2)}%`);
    });

    // Step 4: Enrich with funders
    console.log(`\n${BOLD}Fetching funders...${RESET}`);
    await enrichWithFunders(tokenData.holders);

    // Step 5: Run scoring
    const result = analyze(tokenData);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // Step 6: Print results
    console.log(`\n${BOLD}Score: ${colorScore(result.score)}/100 | Bars: ${result.bars}/5 | Time: ${elapsed}s${RESET}`);

    if (result.noBuy.length > 0) {
      console.log(`\n${RED}${BOLD}NO-BUY REASONS:${RESET}`);
      result.noBuy.forEach(r => console.log(`  ${RED}✗ ${r}${RESET}`));
    } else {
      console.log(`\n${GREEN}No no-buy flags triggered${RESET}`);
    }

    console.log(`\n${BOLD}All Flags:${RESET}`);
    result.flags.forEach(f => {
      const color = f.severity === 'critical' ? RED : f.severity === 'high' ? YELLOW : CYAN;
      console.log(`  ${color}[${f.severity.toUpperCase()}] ${f.text}${RESET}`);
      if (f.detail) console.log(`         ${f.detail}`);
    });

    // Step 7: Pass/fail check
    const didNoBuy = result.noBuy.length > 0;
    const passed = didNoBuy === expectedNoBuy;
    console.log(`\n${BOLD}Expected no-buy: ${expectedNoBuy} | Got no-buy: ${didNoBuy} → ${passed ? `${GREEN}PASS` : `${RED}FAIL`}${RESET}`);

    return { label, score: result.score, passed, noBuy: result.noBuy, lpCount: lps.length };

  } catch (err) {
    console.error(`${RED}ERROR: ${err.message}${RESET}`);
    return { label, score: null, passed: false, error: err.message };
  }
}

async function main() {
  console.log(`${BOLD}${CYAN}RugScanner LP Detection Test Suite${RESET}`);
  console.log(`Running ${TEST_TOKENS.length} test(s)...\n`);

  const summary = [];
  for (const token of TEST_TOKENS) {
    const result = await testToken(token);
    summary.push(result);
  }

  // Summary table
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${BOLD}SUMMARY${RESET}`);
  console.log('═'.repeat(60));
  summary.forEach(r => {
    const status = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const score = r.score != null ? colorScore(r.score) : `${RED}ERROR${RESET}`;
    console.log(`  ${status} | ${r.label} | Score: ${score} | LPs: ${r.lpCount ?? '?'}`);
  });

  const passed = summary.filter(r => r.passed).length;
  console.log(`\n${passed}/${summary.length} tests passed`);
}

main().catch(console.error);
