require('dotenv').config();
const { analyzeToken, enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: function(origin, callback) {
    // Allow all chrome extensions, localhost, and our site
    if (!origin) return callback(null, true);
    if (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost') ||
      origin === process.env.SITE_URL
    ) {
      return callback(null, true);
    }
    callback(null, true); // Allow all origins for now
  },
  credentials: true
}));

// JSON parser for all routes except webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.static('public'));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

async function requirePro(req, res, next) {
  const { data: user } = await supabase
    .from('users')
    .select('stripe_subscription_status')
    .eq('id', req.userId)
    .single();

  if (!user || user.stripe_subscription_status !== 'active') {
    return res.status(403).json({ error: 'PRO subscription required' });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── SIGNUP ────────────────────────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    // Check if user already exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) return res.status(400).json({ error: 'Account already exists with this email' });

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create Stripe customer
    const customer = await stripe.customers.create({ email: email.toLowerCase() });

    // Save user
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        stripe_customer_id: customer.id,
        stripe_subscription_status: 'inactive',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Send welcome email
    await resend.emails.send({
      from: `RugScanner Pro <noreply@${process.env.EMAIL_DOMAIN}>`,
      to: email,
      subject: 'Welcome to RugScanner Pro',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#00ff88;">Welcome to RugScanner Pro</h2>
          <p>Your account has been created. You can now log into the extension and subscribe to unlock AI analysis.</p>
          <p style="color:#888;font-size:13px;">Stay sharp out there.</p>
        </div>
      `
    });

    // Return session token
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, isPro: false });

  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      email: user.email,
      isPro: user.stripe_subscription_status === 'active'
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── GET SESSION (extension calls this on load to check if still logged in) ───
app.get('/auth/me', requireAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('email, stripe_subscription_status')
    .eq('id', req.userId)
    .single();

  if (!user) return res.status(401).json({ error: 'User not found' });

  res.json({
    email: user.email,
    isPro: user.stripe_subscription_status === 'active'
  });
});

// ── CREATE STRIPE CHECKOUT SESSION ───────────────────────────────────────────
app.post('/billing/checkout', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    const session = await stripe.checkout.sessions.create({
      customer: user.stripe_customer_id,
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.SITE_URL}/success.html`,
      cancel_url: `${process.env.SITE_URL}/cancel.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ── CREATE STRIPE PORTAL (manage/cancel subscription) ────────────────────────
app.post('/billing/portal', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: process.env.SITE_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const subscription = event.data.object;

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await supabase
        .from('users')
        .update({ stripe_subscription_status: subscription.status })
        .eq('stripe_customer_id', subscription.customer);
      break;

    case 'customer.subscription.deleted':
      await supabase
        .from('users')
        .update({ stripe_subscription_status: 'inactive' })
        .eq('stripe_customer_id', subscription.customer);
      break;
  }

  res.json({ received: true });
});

// ── AI ANALYSIS ───────────────────────────────────────────────────────────────
app.post('/analyze', requireAuth, requirePro, async (req, res) => {
  const { holders, flags, score, stats } = req.body;

  if (!holders || !Array.isArray(holders)) {
    return res.status(400).json({ error: 'Invalid holder data' });
  }

  // Format holder data for Claude
  const holderSummary = holders
    .filter(h => !h.isLP)
    .slice(0, 25)
    .map(h => [
      `Rank ${h.rank}:`,
      h.percentage != null ? `${h.percentage.toFixed(1)}% remaining` : '',
      h.balance != null ? `${h.balance} SOL balance` : '',
      h.funderAddress ? `funded by ${h.funderAddress}` : '',
      h.clockNumber != null ? `clock #${h.clockNumber}` : '',
      h.hasLeaf ? `[NEW WALLET]` : '',
      h.hasBundle ? `[BUNDLE HISTORY]` : '',
      h.software !== 'unknown' ? `[${h.software}]` : '',
    ].filter(Boolean).join(' '))
    .join('\n');

  const flagSummary = flags
    .map(f => `[${f.severity.toUpperCase()}] ${f.text}`)
    .join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are RugScanner Pro, an expert Solana meme coin rug pull detector built for fast-paced crypto trading on trade.padre.gg.

Your job is to analyze the top 25 holders of a coin and give a sharp, direct verdict in 2-4 sentences. You think like an experienced on-chain analyst with sharp instincts.

DETECTION CRITERIA YOU CARE ABOUT MOST:
- Same funder address across multiple wallets = coordinated bundle
- Same clock number across wallets = funded at same time = coordinated
- Abundance of NEW WALLET (leaf) icons = fresh wallets created just to buy this coin
- BUNDLE HISTORY icons = wallets with prior bundling activity
- Similar SOL balances across top holders = funded from same source
- Identical holding percentages across suspected bundle wallets
- 5+ consecutive wallets using same software (Photon, Axiom, Terminal)
- Any wallet holding more % than the LP
- Any wallet over 8% = instant red flag

TONE: Direct, confident, no fluff. Traders are in a fast market. Lead with the verdict, then explain why in plain English. If it's a rug, say so clearly. If it looks clean, say that too.

FORMAT: 2-4 sentences maximum. No bullet points. No hedging. End with a one-line action: "Do not buy." or "Looks safe to enter." or "Proceed with caution."`,
      messages: [{
        role: 'user',
        content: `Analyze this coin. Risk score: ${score}/100.

TOP 25 HOLDERS:
${holderSummary}

FLAGS DETECTED:
${flagSummary || 'None'}

STATS:
- Total holders: ${stats?.holderCount ?? 'unknown'}
- Bundle icon count: ${stats?.bundleCount ?? 0}
- New wallet count: ${stats?.leafCount ?? 0}
- Same software streak: ${stats?.maxConsecutiveSoftware ?? 0}x ${stats?.dominantSoftware ?? ''}

Give your verdict.`
      }]
    });

    const analysis = message.content[0]?.text || 'Analysis unavailable.';
    res.json({ analysis });

  } catch (err) {
    console.error('AI analysis error:', err);
    res.status(500).json({ error: 'AI analysis failed. Please try again.' });
  }
});

// ── TEST ROUTE ───────────────────────────────────────────────────────────────
app.post('/scan/test', requireAuth, async (req, res) => {
  const { ca } = req.body;
  console.log('[TEST] CA received:', ca);
  console.log('[TEST] HELIUS_API_KEY present:', !!process.env.HELIUS_API_KEY);
  console.log('[TEST] HELIUS_API_KEY length:', process.env.HELIUS_API_KEY?.length);
  
  try {
    // Test basic Helius connectivity
    const testRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method: 'getTokenSupply',
        params: [ca]
      })
    });
    const testData = await testRes.json();
    console.log('[TEST] Helius response:', JSON.stringify(testData).slice(0, 300));
    res.json({ success: true, heliusResponse: testData });
  } catch (err) {
    console.error('[TEST] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SCAN ROUTES ───────────────────────────────────────────────────────────────

app.post('/scan/quick', requireAuth, async (req, res) => {
  const { ca } = req.body;
  if (!ca) return res.status(400).json({ error: 'CA required' });

  try {
    const tokenData = await analyzeToken(ca, process.env.HELIUS_API_KEY, false);
    const result = analyze(tokenData);
    res.json({ ...result, holders: tokenData.holders });
  } catch (err) {
    console.error('Quick scan error:', err);
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

app.post('/scan/ai', requireAuth, requirePro, async (req, res) => {
  const { ca } = req.body;
  if (!ca) return res.status(400).json({ error: 'CA required' });

  try {
    console.log('[AI Scan] Starting for', ca);
    const tokenData = await analyzeToken(ca);
    await enrichWithFunders(tokenData.holders);
    console.log('[AI Scan] Funder enrichment complete');
    const result = analyze(tokenData);

    // Build holder summary for Claude
    const holderSummary = tokenData.holders
      .filter(h => !h.isLP)
      .slice(0, 25)
      .map(h => [
        `Rank ${h.rank}:`,
        h.percentage != null ? `${h.percentage.toFixed(1)}%` : '',

        h.funderAddress ? `funded by ${h.funderAddress}` : '',
        h.identity ? `[${h.identity}]` : '',
        h.walletAgeSeconds != null ? `wallet age: ${Math.round(h.walletAgeSeconds/86400)}d` : '',
      ].filter(Boolean).join(' '))
      .join('\n');

    const flagSummary = result.flags.map(f => `[${f.severity.toUpperCase()}] ${f.text}`).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are RugScanner Pro — a rug pull detection tool built for experienced Solana meme coin traders on trade.padre.gg. You think like a sharp, fast trader who has seen hundreds of bundled coins and knows exactly what to look for.

You are a sharp Solana meme coin trading advisor. Your job is two things: detect rugs AND advise against bad buys. A bad buy is just as bad as a rug — if it doesn't look good, say don't buy it.

VERDICT CATEGORIES — pick the right one:

- DEATH TRAP: 90%+ of holders share one funder. "This coin is fully bundled, ranks 2-19 all funded by the same wallet. Do not buy."

- BUNDLE DETECTED: Clear coordination — same funder across 5+ wallets, or new wallets funded in same time window controlling significant %. Three sentences: verdict, what gave it away, why it's dangerous.

- BAD BUY (no bundle, but still don't buy): Use when there's no bundle but the coin has leverage risk. Examples: any single wallet over 4%, top holder over 8%, one wallet clearly dominates. "Not a bundle, but rank #2 holds 7.6% — that's too much leverage on one wallet. If they sell, the chart dumps. Pass."

- PROCEED WITH CAUTION: Minor concerns worth watching but not disqualifying alone. Briefly name the concern and why you're still cautious.

- LOOKS CLEAN: No flags worth worrying about. One sentence, confident. Move on.

BAD BUY SIGNALS (not rugs, but still pass):
- Any wallet over 4% = leverage risk, they can dump on you
- Any wallet over 8% = strong no-buy, too much control
- Top 3 holders combined own over 20% = concentrated leverage
- Coin has under 200 holders = too thin, easy to manipulate
- Any wallet holding more % than the LP = immediate no-buy

CRITICAL RULE: If risk score is under 40 and no critical flags exist, do NOT call it a bundle. Call it clean or a bad buy depending on the holder distribution.

TONE: Direct, fast, talk like a trader. No bullet points. No hedging. One clear recommendation at the end of every verdict: "Buy." / "Pass." / "Do not buy.".`,
      messages: [{
        role: 'user',
        content: `Analyze this coin. Risk score: ${result.score}/100. Death trap: ${result.isDeathTrap}.

TOP 25 HOLDERS:
${holderSummary}

FLAGS:
${flagSummary || 'None'}

Give your verdict.`
      }]
    });

    const aiAnalysis = message.content[0]?.text || 'Analysis unavailable.';
    
    // Sync score with AI verdict — if AI says bundle/death trap, score should reflect it
    const aiLower = aiAnalysis.toLowerCase();
    if (aiLower.includes('death trap') || aiLower.includes('fully bundled')) {
      result.score = Math.max(result.score, 90);
      result.bars = 5;
    } else if (aiLower.includes('bundle detected') || aiLower.includes('do not buy')) {
      result.score = Math.max(result.score, 70);
      result.bars = Math.max(result.bars, 4);
    } else if (aiLower.includes('bad buy') || aiLower.includes('pass')) {
      result.score = Math.max(result.score, 45);
      result.bars = Math.max(result.bars, 3);
    }

    res.json({ ...result, holders: tokenData.holders, aiAnalysis });

  } catch (err) {
    console.error('AI scan error:', err);
    if (err.message?.includes('429') || err.message?.includes('rate')) {
      return res.status(429).json({ error: 'Rate limit hit — wait 30 seconds and try again.' });
    }
    res.status(500).json({ error: err.message || 'AI scan failed' });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RugScanner Pro backend running on port ${PORT}`));
