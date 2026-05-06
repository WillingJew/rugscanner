// RugScanner Pro - Detection Engine
// Clean implementation of Jack's bundle detection criteria

function analyze(tokenData) {
  const { holders, holderCount } = tokenData;
  const real = holders.filter(h => !h.isLP);

  const flags = [];
  const noBuy = [];
  let score = 0;

  function flag(text, severity, detail = '') {
    flags.push({ text, severity, detail });
  }

  // ── 1. LP NOT AT RANK 1 ──────────────────────────────────────────────────
  const lp = holders.find(h => h.isLP);
  if (lp && lp.rank !== 1) {
    flag(`LP is not rank #1 — it's rank #${lp.rank}`, 'critical');
    noBuy.push('LP is not #1 holder');
    score += 40;
  }

  // ── 2. DEATH TRAP — same funder across 90%+ of holders ──────────────────
  const funderMap = {};
  for (const h of real) {
    if (!h.funder) continue;
    funderMap[h.funder] = (funderMap[h.funder] || []);
    funderMap[h.funder].push(h);
  }

  const withFunder = real.filter(h => h.funder);
  let deathTrap = false;

  for (const [addr, group] of Object.entries(funderMap)) {
    if (withFunder.length < 3) continue;
    const ratio = group.length / withFunder.length;
    if (ratio >= 0.9 && group.length >= 5) {
      deathTrap = true;
      const ranks = group.map(h => h.rank);
      flag(
        `Death trap: ${group.length}/${real.length} holders funded by same wallet`,
        'critical',
        `Ranks ${Math.min(...ranks)}-${Math.max(...ranks)} — one entity owns this coin`
      );
      noBuy.push(`${group.length} holders share one funder — death trap`);
      score += 80;
      break;
    }
  }

  // ── 3. FUNDER CLUSTERS (non-death-trap) ──────────────────────────────────
  if (!deathTrap) {
    for (const [addr, group] of Object.entries(funderMap)) {
      if (group.length < 2) continue;
      const totalPct = group.reduce((s, h) => s + h.percentage, 0);
      const ranks = group.map(h => `#${h.rank}`).join(', ');

      if (group.length >= 5 || totalPct >= 12) {
        flag(`${group.length} wallets share funder — ${totalPct.toFixed(1)}% combined`, 'critical', `Ranks: ${ranks}`);
        noBuy.push(`Funder cluster controls ${totalPct.toFixed(1)}%`);
        score += 35;
      } else if (totalPct >= 4) {
        flag(`${group.length} wallets share funder — ${totalPct.toFixed(1)}% combined`, 'high', `Ranks: ${ranks}`);
        score += 18;
      } else {
        flag(`${group.length} wallets share funder`, 'medium', `Ranks: ${ranks}`);
        score += 8;
      }
    }
  }

   // ── 3b. CEX LABEL CLUSTERS ───────────────────────────────────────────────
  // Wallets funded by different addresses but same CEX label (e.g. 6x "Coinbase")
  const CEX_LABELS = ['coinbase', 'binance', 'kraken', 'okx', 'bybit', 'kucoin'];
  const cexLabelMap = {};

  for (const h of real) {
    if (!h.funderLabel) continue;
    const label = h.funderLabel.toLowerCase();
    const match = CEX_LABELS.find(cex => label.includes(cex));
    if (!match) continue;
    if (!cexLabelMap[match]) cexLabelMap[match] = [];
    cexLabelMap[match].push(h);
  }

  for (const [cex, group] of Object.entries(cexLabelMap)) {
    if (group.length < 3) continue;
    const totalPct = group.reduce((s, h) => s + h.percentage, 0);
    const ranks = group.map(h => `#${h.rank}`).join(', ');
    const label = cex.charAt(0).toUpperCase() + cex.slice(1);

    if (group.length >= 5 || totalPct >= 15) {
      flag(`${group.length} wallets all funded via ${label} — ${totalPct.toFixed(1)}% combined`, 'critical',
        `Ranks: ${ranks} — CEX-sourced cluster, coordinated setup disguised as retail`);
      noBuy.push(`${group.length} ${label}-funded wallets control ${totalPct.toFixed(1)}%`);
      score += 35;
    } else {
      flag(`${group.length} wallets all funded via ${label} — ${totalPct.toFixed(1)}% combined`, 'high',
        `Ranks: ${ranks} — same CEX funder across multiple wallets is suspicious`);
      score += 20;
    }
  }
  
  // ── 4. INDIVIDUAL WALLET % ────────────────────────────────────────────────
  for (const h of real) {
    if (h.percentage >= 8) {
      flag(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}% — over 8%`, 'critical',
        'Single wallet with this much control will dump on buyers');
      noBuy.push(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}%`);
      score += 40;
    } else if (h.percentage >= 4) {
      flag(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}% — over 4%`, 'high',
        'Leverage risk — this wallet can move the chart');
      score += 18;
    }
  }

  // ── 5. IDENTICAL % GROUPS ─────────────────────────────────────────────────
  const pctGroups = {};
  for (const h of real) {
    const key = h.percentage.toFixed(1);
    pctGroups[key] = (pctGroups[key] || []);
    pctGroups[key].push(h);
  }
 for (const [pct, group] of Object.entries(pctGroups)) {
    if (group.length < 5) continue;

    if (group.length >= 8) {
      flag(`${group.length} wallets all hold exactly ${pct}% — identical holdings`, 'critical',
        'Natural buying never creates perfect identical percentages — this is a bundle');
      noBuy.push(`${group.length} wallets hold identical ${pct}% — coordinated bundle`);
      score += 50;
    } else if (group.length >= 5) {
      flag(`${group.length} wallets all hold exactly ${pct}% — identical holdings`, 'high',
        'Natural buying never creates perfect identical percentages');
      score += 20;
    }
  }

  // ── 6. SOL BALANCE UNIFORMITY ────────────────────────────────────────────
  // Identical SOL balances across top holders = funded from same source
  const withBal = real.filter(h => h.solBalance != null && h.solBalance > 0 && h.solBalance < 100);
  if (withBal.length >= 4) {
    // Group wallets within 0.005 SOL of each other (very tight — catches exact matches)
    const sorted = [...withBal].sort((a, b) => a.solBalance - b.solBalance);
    let bestGroup = [];
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter(h => Math.abs(h.solBalance - sorted[i].solBalance) <= 0.005);
      if (group.length > bestGroup.length) bestGroup = group;
    }

    if (bestGroup.length >= 4) {
      const avg = bestGroup.reduce((s, h) => s + h.solBalance, 0) / bestGroup.length;
      const totalPct = bestGroup.reduce((s, h) => s + h.percentage, 0);
      const ranks = bestGroup.map(h => `#${h.rank}`).join(', ');

      if (bestGroup.length >= 8) {
        flag(`${bestGroup.length} wallets all have identical SOL balance (${avg.toFixed(3)} SOL)`, 'critical',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        noBuy.push(`${bestGroup.length} wallets share identical SOL balance`);
        score += 35;
      } else if (bestGroup.length >= 5) {
        flag(`${bestGroup.length} wallets share identical SOL balance (${avg.toFixed(3)} SOL)`, 'high',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        score += 20;
      } else {
        flag(`${bestGroup.length} wallets share identical SOL balance (${avg.toFixed(3)} SOL)`, 'medium',
          `Ranks: ${ranks}`);
        score += 10;
      }
    }
  }

  // ── 7. TOP HOLDER CONCENTRATION ──────────────────────────────────────────

  // ── 6c. CLOCK BADGE DETECTION (scraped from Terminal UI) ─────────────────
  // Terminal shows clock icons with numbers indicating how many wallets share a funder
  // clockIconCount = how many rows had the icon, maxClockNumber = biggest group size
  const clockIconCount = tokenData.clockIconCount || 0;
  const maxClockNumber = tokenData.maxClockNumber || 0;

  if (clockIconCount > 0 || maxClockNumber > 0) {
    if (maxClockNumber >= 10) {
      flag(`${maxClockNumber} accounts connected via same funder (Terminal clock badge)`, 'critical',
        `${clockIconCount} rows flagged — Terminal detected coordinated funding across ${maxClockNumber} wallets`);
      noBuy.push(`${maxClockNumber} wallets connected — coordinated bundle`);
      score += 45;
    } else if (clockIconCount >= 10) {
      flag(`${clockIconCount} holders have clock badges — widespread funder connections`, 'critical',
        `Largest connected group: ${maxClockNumber} wallets`);
      noBuy.push(`${clockIconCount} holders flagged with funder connections`);
      score += 40;
    } else if (clockIconCount >= 4) {
      flag(`${clockIconCount} holders have clock badges — funder connections detected`, 'high',
        `Largest connected group: ${maxClockNumber} wallets`);
      score += 20;
    }
  }

  // ── 6d. CONSECUTIVE ICON RUNS ────────────────────────────────────────────
  // Adjacent-rank runs of holders sharing the same Padre UI icon. Treated as a
  // possible hidden bundle — not chart-tanking by itself, but worth noting.
  // Applied separately to each icon family:
  //   - software brand (Axiom / Photon / Terminal — must match exactly; mixed brands ignored)
  //   - bundle icon (Padre's stacked-diamond marker)
  //   - fresh-wallet icon (Padre's leaf marker)
  //   - insider icon (Padre's ghost marker)
  //
  // Per-run severity: 4-5 = low (+5), 6 = medium (+12), 7+ = critical (+30).
  // Override: if a run's combined % > 8 it becomes critical (+40) and adds noBuy,
  // regardless of length — that much supply concentrated in one icon group is a real risk.
  //
  // Multiple runs of the same icon label (e.g. two separate stretches of consecutive
  // Axiom wallets) are merged into a single flag so the UI doesn't show duplicate
  // entries. Severity = worst run's severity. Points = sum of all runs' points.
  const orderedReal = [...real].sort((a, b) => a.rank - b.rank);

  // label → array of runs (each run is an array of consecutive holders)
  const iconRunsByLabel = Object.create(null);

  // scanIconRuns: walks orderedReal looking for runs where matchFn(holder) is truthy
  // AND each consecutive pair satisfies sameAs() AND ranks are strictly adjacent.
  // When a run of >=4 ends, stores it in iconRunsByLabel under the labelFn() key.
  function scanIconRuns(matchFn, sameAs, labelFn) {
    let i = 0;
    while (i < orderedReal.length) {
      if (!matchFn(orderedReal[i])) { i++; continue; }
      let j = i + 1;
      while (
        j < orderedReal.length &&
        matchFn(orderedReal[j]) &&
        sameAs(orderedReal[i], orderedReal[j]) &&
        orderedReal[j].rank === orderedReal[j - 1].rank + 1
      ) {
        j++;
      }
      const run = orderedReal.slice(i, j);
      if (run.length >= 4) {
        const label = labelFn(orderedReal[i]);
        if (!iconRunsByLabel[label]) iconRunsByLabel[label] = [];
        iconRunsByLabel[label].push(run);
      }
      i = j;
    }
  }

  // Same-brand software runs only — mixed brands (Axiom→Photon→Terminal) are NOT
  // a bundle signal, they're just retail diversity. Capitalised label for the message.
  scanIconRuns(
    h => !!h.software,
    (a, b) => a.software === b.software,
    h => h.software.charAt(0).toUpperCase() + h.software.slice(1)
  );

  // Bundle icon runs — Padre marks wallets with prior bundling history.
  scanIconRuns(
    h => !!h.isBundled,
    () => true,
    () => 'bundle-icon'
  );

  // Fresh-wallet (leaf) runs — newly funded wallets with no trading history.
  scanIconRuns(
    h => !!h.isFreshWallet,
    () => true,
    () => 'fresh-wallet'
  );

  // Insider (ghost) runs — wallets that bought pre-bond / pre-launch.
  scanIconRuns(
    h => !!h.isInsider,
    () => true,
    () => 'insider'
  );

  // Emit one flag per icon label, merging multiple runs of the same icon type
  // into a single message so the UI doesn't show duplicate "X consecutive Axiom..." rows.
  const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
  function classifyRun(run) {
    const count = run.length;
    const pct = run.reduce((s, h) => s + (h.percentage || 0), 0);
    if (pct > 8)        return { severity: 'critical', points: 40, noBuy: true,  pct };
    if (count >= 7)     return { severity: 'critical', points: 30, noBuy: true,  pct };
    if (count === 6)    return { severity: 'medium',   points: 12, noBuy: false, pct };
    return                     { severity: 'low',      points: 5,  noBuy: false, pct };
  }

  for (const [label, runs] of Object.entries(iconRunsByLabel)) {
    const classified = runs.map(r => ({ run: r, ...classifyRun(r) }));
    const totalCount  = runs.reduce((s, r) => s + r.length, 0);
    const totalPct    = classified.reduce((s, c) => s + c.pct, 0);
    const ranges      = runs.map(r => `${r[0].rank}-${r[r.length - 1].rank}`).join(', ');
    const worstSev    = classified.reduce(
      (worst, c) => (SEV_RANK[c.severity] > SEV_RANK[worst] ? c.severity : worst),
      'low'
    );
    const totalPoints = classified.reduce((s, c) => s + c.points, 0);
    const anyNoBuy    = classified.some(c => c.noBuy);
    const overEight   = classified.some(c => c.pct > 8);

    let text, detail;
    if (runs.length === 1) {
      text   = `${totalCount} consecutive ${label} wallets — ${totalPct.toFixed(1)}% combined`;
      detail = overEight
        ? `Ranks ${ranges} — cluster controls more than 8% of supply`
        : `Ranks ${ranges}`;
    } else {
      text   = `${totalCount} ${label} wallets across ${runs.length} consecutive groups — ${totalPct.toFixed(1)}% combined`;
      detail = overEight
        ? `Ranks ${ranges} — at least one cluster controls more than 8%`
        : `Ranks ${ranges}`;
    }

    flag(text, worstSev, detail);
    if (anyNoBuy) {
      noBuy.push(
        runs.length === 1
          ? `${totalCount} consecutive ${label} wallets at ranks ${ranges}`
          : `${totalCount} ${label} wallets in ${runs.length} consecutive groups (ranks ${ranges})`
      );
    }
    score += totalPoints;
  }

  // ── 6b. WALLET BIRTH TIME CLUSTERING ─────────────────────────────────────
  // If many holders' wallets were created within the same 5-minute window = coordinated
  const withBirth = real.filter(h => h.fundedAt != null);
  if (withBirth.length >= 4) {
    // Sort by birth time, then find the largest cluster within 300s (5 min)
    const sorted = [...withBirth].sort((a, b) => a.fundedAt - b.fundedAt);
    let bestCluster = [];

    for (let i = 0; i < sorted.length; i++) {
      const window = sorted.filter(h => h.fundedAt >= sorted[i].fundedAt && h.fundedAt <= sorted[i].fundedAt + 300);
      if (window.length > bestCluster.length) bestCluster = window;
    }

    if (bestCluster.length >= 5) {
      const totalPct = bestCluster.reduce((s, h) => s + h.percentage, 0);
      const ranks = bestCluster.map(h => `#${h.rank}`).join(', ');
      const spanSec = bestCluster[bestCluster.length - 1].fundedAt - bestCluster[0].fundedAt;
      const spanLabel = spanSec < 60 ? `${spanSec}s` : `${Math.round(spanSec / 60)}m`;

      if (bestCluster.length >= 8) {
        flag(`${bestCluster.length} wallets all created within ${spanLabel} of each other`, 'critical',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined — coordinated wallet creation`);
        noBuy.push(`${bestCluster.length} wallets born in same ${spanLabel} window — coordinated`);
        score += 40;
      } else {
        flag(`${bestCluster.length} wallets created within ${spanLabel} of each other`, 'high',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        score += 20;
      }
    }
  }

  const top5pct = real.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
  const top10pct = real.slice(0, 10).reduce((s, h) => s + h.percentage, 0);

  if (top5pct >= 40) {
    flag(`Top 5 holders control ${top5pct.toFixed(1)}%`, 'high');
    score += 15;
  }
  if (top10pct >= 60) {
    flag(`Top 10 holders control ${top10pct.toFixed(1)}%`, 'high');
    score += 15;
  }

  // ── 7. STABILITY CREDIT FOR LARGE COINS ──────────────────────────────────
  if (noBuy.length === 0 && holderCount >= 2000) score = Math.max(0, score - 15);
  else if (noBuy.length === 0 && holderCount >= 1000) score = Math.max(0, score - 8);

  // ── SCORE FLOORS ──────────────────────────────────────────────────────────
  const crits = flags.filter(f => f.severity === 'critical').length;
  if (deathTrap) score = Math.max(score, 95);
  else if (crits >= 3) score = Math.max(score, 90);
  else if (crits >= 2) score = Math.max(score, 80);
  else if (crits >= 1) score = Math.max(score, 60);

  score = Math.min(100, Math.max(0, score));

  const bars = score >= 85 ? 5 : score >= 65 ? 4 : score >= 40 ? 3 : score >= 20 ? 2 : 1;

  // ── STATS FOR UI ──────────────────────────────────────────────────────────
  const funderClusters = Object.values(funderMap).filter(g => g.length >= 2).length;
  const topHolder = real[0];

  return {
    score,
    bars,
    flags,
    noBuy,
    holderCount,
    deathTrap,
    stats: {
      topHolderPct: topHolder?.percentage ?? null,
      funderClusters,
    }
  };
}

module.exports = { analyze };
