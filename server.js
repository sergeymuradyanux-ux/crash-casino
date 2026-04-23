const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ══ GAME STATE ══ */
let gameState = {
  phase: 'waiting',
  countdown: 10,
  multiplier: 1.00,
  crashPoint: 1.00,
  startTime: null,
  roundId: Date.now(),
  bets: [],
};

let gameInterval = null;
let countdownInterval = null;

/*
 * ══ CASHOUT LOCK SET ══
 * Prevents race conditions where two cashout messages arrive
 * simultaneously (e.g. desktop double-click or WS retry).
 * Key: String(userId) — present while DB write is in flight.
 */
const cashoutInProgress = new Set();

/* ── helpers ── */
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function genCrash() {
  const r = Math.random();
  if (r < 0.45) return parseFloat((1 + Math.random() * 0.4).toFixed(2));
  if (r < 0.70) return parseFloat((1.4 + Math.random() * 0.8).toFixed(2));
  if (r < 0.88) return parseFloat((2.2 + Math.random() * 2.8).toFixed(2));
  if (r < 0.97) return parseFloat((5 + Math.random() * 10).toFixed(2));
  return parseFloat((15 + Math.random() * 35).toFixed(2));
}

function getPublicState() {
  return {
    phase: gameState.phase,
    countdown: gameState.countdown,
    multiplier: gameState.multiplier,
    crashPoint: gameState.phase === 'crashed' ? gameState.crashPoint : null,
    roundId: gameState.roundId,
    bets: gameState.bets,
  };
}

/* ══ GAME LOOP ══ */
function startWaiting() {
  gameState.phase = 'waiting';
  gameState.bets = [];
  gameState.multiplier = 1.00;
  gameState.roundId = Date.now();
  cashoutInProgress.clear();           /* reset all locks each round */
  broadcast({ type: 'state', game: getPublicState() });
  setTimeout(startCountdown, 3000);
}

function startCountdown() {
  gameState.phase = 'countdown';
  gameState.countdown = 10;
  gameState.crashPoint = genCrash();
  broadcast({ type: 'state', game: getPublicState() });

  countdownInterval = setInterval(() => {
    gameState.countdown--;
    broadcast({ type: 'countdown', value: gameState.countdown });
    if (gameState.countdown <= 0) {
      clearInterval(countdownInterval);
      startRound();
    }
  }, 1000);
}

function startRound() {
  gameState.phase = 'running';
  gameState.startTime = Date.now();
  broadcast({ type: 'state', game: getPublicState() });

  gameInterval = setInterval(async () => {
    const elapsed = (Date.now() - gameState.startTime) / 1000;
    gameState.multiplier = parseFloat(
      Math.pow(Math.E, 0.12 * elapsed * Math.pow(elapsed, 0.3)).toFixed(2)
    );
    if (gameState.multiplier < 1) gameState.multiplier = 1;

    /* ── auto-cashout check ── */
    for (const bet of gameState.bets) {
      if (
        !bet.cashedAt &&
        !bet.lost &&
        bet.autoCashout &&
        gameState.multiplier >= bet.autoCashout &&
        !cashoutInProgress.has(String(bet.userId))
      ) {
        cashoutInProgress.add(String(bet.userId));
        bet.cashedAt = gameState.multiplier;
        const payout = Math.floor(bet.amount * bet.cashedAt);
        const profit  = payout - bet.amount;

        try {
          const { data: user } = await supabase
            .from('users').select('coins, stars_won')
            .eq('telegram_id', bet.userId).single();
          if (user) {
            await supabase.from('users').update({
              coins: (user.coins || 0) + payout,
              stars_won: (user.stars_won || 0) + Math.max(0, profit)
            }).eq('telegram_id', bet.userId);
            await supabase.from('transactions').insert({
              telegram_id: bet.userId,
              description: `Auto cashout x${bet.cashedAt}`,
              delta: profit, bet: bet.amount,
              cashed_out_at: bet.cashedAt, won: true
            });
          }
        } catch (e) {
          console.error('Auto cashout DB error:', e);
        } finally {
          cashoutInProgress.delete(String(bet.userId));
        }

        /* Broadcast to ALL — client filters by userId */
        broadcast({ type: 'cashout_ok', userId: bet.userId, mult: bet.cashedAt, payout });
        broadcast({ type: 'cashout',    userId: bet.userId, mult: bet.cashedAt });
        console.log(`Auto cashout: user ${bet.userId} at x${bet.cashedAt}`);
      }
    }

    broadcast({ type: 'tick', mult: gameState.multiplier, bets: gameState.bets });

    if (gameState.multiplier >= gameState.crashPoint) doCrash();
  }, 100);
}

function doCrash() {
  clearInterval(gameInterval);
  gameInterval = null;
  gameState.phase = 'crashed';

  gameState.bets.forEach(bet => {
    if (!bet.cashedAt) {
      bet.lost = true;
      supabase.from('transactions').insert({
        telegram_id: bet.userId,
        description: `Lost at x${gameState.crashPoint}`,
        delta: -bet.amount, bet: bet.amount,
        cashed_out_at: null, won: false
      }).catch(() => {});
    }
  });

  broadcast({ type: 'crashed', mult: gameState.crashPoint, bets: gameState.bets });
  saveCrashHistory(gameState.crashPoint);
  setTimeout(startWaiting, 4000);
}

async function saveCrashHistory(point) {
  try {
    await supabase.from('crash_history').insert({
      crash_point: point, created_at: new Date().toISOString()
    });
  } catch (e) {}
}

/* ══ WEBSOCKET HANDLER ══ */
/* ══ SERVER-SIDE WS HEARTBEAT — detects dead connections every 30s ══ */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log('Client connected, total:', wss.clients.size);
  ws.send(JSON.stringify({ type: 'state', game: getPublicState() }));

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      /* ── PING (keepalive from client) ── */
      if (data.type === 'ping') {
        sendTo(ws, { type: 'pong' });
        return;
      }

      /* ────────────────── PLACE BET ────────────────── */
      if (data.type === 'bet') {
        const { userId, username, photoUrl, amount, autoCashout } = data;

        if (!userId || !amount || amount < 50) {
          return sendTo(ws, { type: 'bet_error', msg: 'Invalid bet' });
        }
        if (gameState.phase !== 'waiting' && gameState.phase !== 'countdown' && gameState.phase !== 'crashed') {
          return sendTo(ws, { type: 'bet_error', msg: 'Round already started' });
        }
        if (gameState.bets.find(b => String(b.userId) === String(userId))) {
          return sendTo(ws, { type: 'bet_error', msg: 'Already bet this round' });
        }

        const { data: user } = await supabase
          .from('users').select('coins').eq('telegram_id', userId).single();

        if (!user || user.coins < amount) {
          return sendTo(ws, { type: 'bet_error', msg: 'Insufficient balance' });
        }

        await supabase.from('users')
          .update({ coins: user.coins - amount }).eq('telegram_id', userId);

        gameState.bets.push({
          userId, username,
          photoUrl: photoUrl || null,
          amount,
          autoCashout: autoCashout ? parseFloat(autoCashout) : null,
          cashedAt: null,
          lost: false
        });

        sendTo(ws, { type: 'bet_ok', amount });
        broadcast({ type: 'bets_update', bets: gameState.bets });
        console.log(`Bet placed: user ${userId}, amount ${amount}`);
      }

      /* ────────────────── MANUAL CASHOUT ────────────────── */
      if (data.type === 'cashout') {
        const { userId } = data;

        /* ── 5-layer guard ── */
        if (gameState.phase !== 'running') {
          return sendTo(ws, { type: 'cashout_error', msg: 'Game not running' });
        }

        const bet = gameState.bets.find(b => String(b.userId) === String(userId));

        if (!bet) {
          return sendTo(ws, { type: 'cashout_error', msg: 'No bet found' });
        }
        if (bet.cashedAt) {
          /* Already cashed out — silently re-confirm so UI recovers on desktop */
          const payout = Math.floor(bet.amount * bet.cashedAt);
          return sendTo(ws, { type: 'cashout_ok', mult: bet.cashedAt, payout });
        }
        if (bet.lost) {
          return sendTo(ws, { type: 'cashout_error', msg: 'Round already crashed' });
        }
        if (cashoutInProgress.has(String(userId))) {
          /* Another cashout message is already being processed — ignore duplicate */
          return;
        }

        /* ══ LOCK + CAPTURE multiplier at server clock — cannot be spoofed ══ */
        cashoutInProgress.add(String(userId));
        const lockedMult = gameState.multiplier;
        bet.cashedAt    = lockedMult;

        const payout = Math.floor(bet.amount * lockedMult);
        const profit  = payout - bet.amount;

        /* Broadcast bets table update immediately — don't wait for DB */
        broadcast({ type: 'cashout', userId, mult: lockedMult });

        /* DB write */
        try {
          const { data: user } = await supabase
            .from('users').select('coins, stars_won')
            .eq('telegram_id', userId).single();

          if (user) {
            await supabase.from('users').update({
              coins: (user.coins || 0) + payout,
              stars_won: (user.stars_won || 0) + Math.max(0, profit)
            }).eq('telegram_id', userId);

            await supabase.from('transactions').insert({
              telegram_id: userId,
              description: `Won x${lockedMult}`,
              delta: profit, bet: bet.amount,
              cashed_out_at: lockedMult, won: true
            });
          }
        } catch (e) {
          console.error('Cashout DB error:', e);
          /* Bet is locked server-side — still confirm to client */
        } finally {
          cashoutInProgress.delete(String(userId));
        }

        /* Send cashout_ok ONLY to the player who cashed out */
        sendTo(ws, { type: 'cashout_ok', mult: lockedMult, payout });
        console.log(`Manual cashout: user ${userId} at x${lockedMult}, payout ${payout}`);
      }

    } catch (e) {
      console.error('WS message error:', e);
    }
  });

  ws.on('close', () => console.log('Client disconnected, total:', wss.clients.size));
  ws.on('error', (err) => console.error('WS client error:', err.message));
});

/* ══ REST ENDPOINTS ══ */

app.get('/', (req, res) => res.json({ status: 'Geco API running', clients: wss.clients.size }));

/* ── REST CASHOUT FALLBACK — used when WebSocket is disconnected ── */
app.post('/api/cashout-confirm', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid user' });

  /* Use same logic as WS cashout */
  if (gameState.phase !== 'running') {
    return res.json({ success: false, error: 'Game not running' });
  }

  const bet = gameState.bets.find(b => String(b.userId) === String(userId));
  if (!bet) return res.json({ success: false, error: 'No bet found' });
  if (bet.cashedAt) {
    /* Already cashed out — return existing result */
    return res.json({ success: true, mult: bet.cashedAt, payout: Math.floor(bet.amount * bet.cashedAt), alreadyDone: true });
  }
  if (bet.lost) return res.json({ success: false, error: 'Already crashed' });
  if (cashoutInProgress.has(String(userId))) {
    return res.json({ success: false, error: 'Processing' });
  }

  /* Lock and cashout */
  cashoutInProgress.add(String(userId));
  const lockedMult = gameState.multiplier;
  bet.cashedAt = lockedMult;
  const payout = Math.floor(bet.amount * lockedMult);
  const profit  = payout - bet.amount;

  broadcast({ type: 'cashout', userId, mult: lockedMult });

  try {
    const { data: user } = await supabase
      .from('users').select('coins, stars_won').eq('telegram_id', userId).single();
    if (user) {
      await supabase.from('users').update({
        coins: (user.coins || 0) + payout,
        stars_won: (user.stars_won || 0) + Math.max(0, profit)
      }).eq('telegram_id', userId);
      await supabase.from('transactions').insert({
        telegram_id: userId, description: `Won x${lockedMult} (REST)`,
        delta: profit, bet: bet.amount, cashed_out_at: lockedMult, won: true
      });
    }
    broadcast({ type: 'cashout_ok', userId, mult: lockedMult, payout });
    res.json({ success: true, mult: lockedMult, payout });
    console.log(`REST cashout: user ${userId} at x${lockedMult}, payout ${payout}`);
  } catch (e) {
    console.error('REST cashout error:', e);
    res.json({ success: true, mult: lockedMult, payout }); /* still confirm */
  } finally {
    cashoutInProgress.delete(String(userId));
  }
});

function getUserData(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user')); }
  catch { return null; }
}
function getUserId(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user'))?.id; }
  catch { return null; }
}

app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.json({ coins: 1000 });
  const userInfo = getUserData(initData);
  const userId   = userInfo?.id;
  if (!userId) return res.json({ coins: 1000 });
  const firstName = userInfo?.first_name || null;
  const userName  = userInfo?.username   || null;
  try {
    const { data: existing } = await supabase
      .from('users').select('coins, stars_won').eq('telegram_id', userId).single();
    if (existing) {
      await supabase.from('users')
        .update({ first_name: firstName, username: userName }).eq('telegram_id', userId);
      return res.json({ coins: existing.coins || 1000, stars_won: existing.stars_won || 0 });
    }
    const { data: newUser } = await supabase.from('users')
      .insert({ telegram_id: userId, first_name: firstName, username: userName, coins: 1000, stars_won: 0 })
      .select().single();
    return res.json({ coins: newUser?.coins || 1000, stars_won: 0 });
  } catch (e) {
    console.error('User error:', e);
    return res.json({ coins: 1000 });
  }
});

app.post('/api/balance', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.json({ coins: 0 });
  try {
    const { data } = await supabase
      .from('users').select('coins, stars_won').eq('telegram_id', userId).single();
    res.json({ coins: data?.coins || 0, stars_won: data?.stars_won || 0 });
  } catch (e) { res.json({ coins: 0 }); }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase
      .from('users').select('telegram_id, username, stars_won')
      .order('stars_won', { ascending: false }).limit(20);
    res.json({ rows: data || [] });
  } catch (e) { res.json({ rows: [] }); }
});

app.post('/api/create-invoice', async (req, res) => {
  const { initData, stars } = req.body;
  const validAmounts = [100, 200, 500, 1000, 2000, 5000];
  if (!validAmounts.includes(stars)) return res.status(400).json({ error: 'Invalid amount' });
  const userId = getUserId(initData);
  if (!userId) return res.status(400).json({ error: 'Invalid user' });
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Geco Stars',
        description: `Top up ${stars} stars to play Geco Crash`,
        payload: JSON.stringify({ userId, stars, ts: Date.now() }),
        provider_token: '', currency: 'XTR',
        prices: [{ label: `${stars} Stars`, amount: stars }]
      })
    });
    const data = await response.json();
    if (!data.ok) return res.status(500).json({ error: 'Invoice creation failed' });
    res.json({ invoiceLink: data.result });
  } catch (e) {
    console.error('Invoice error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/webhook', async (req, res) => {
  const update = req.body;
  console.log('Webhook:', JSON.stringify(update).substring(0, 200));

  if (update.pre_checkout_query) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
    });
    return res.json({ ok: true });
  }

  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const telegramUserId = update.message.from.id;
    const starsAmount    = payment.total_amount;
    const chargeId       = payment.telegram_payment_charge_id;

    const { data: existing } = await supabase
      .from('payments').select('id').eq('charge_id', chargeId).single();

    if (!existing) {
      const { data: user } = await supabase
        .from('users').select('coins').eq('telegram_id', telegramUserId).single();
      await supabase.from('users')
        .update({ coins: (user?.coins || 0) + starsAmount }).eq('telegram_id', telegramUserId);
      await supabase.from('payments').insert({
        telegram_id: telegramUserId, stars: starsAmount,
        charge_id: chargeId, created_at: new Date().toISOString()
      });
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramUserId,
          text: `✅ Payment confirmed!\n\n⭐ +${starsAmount} stars added to your Geco balance.\n\nReceipt: ${chargeId}`
        })
      });
    }
    return res.json({ ok: true });
  }

  if (update.message?.text?.startsWith('/start')) {
    const parts = update.message.text.split(' ');
    if (parts[1]?.startsWith('ref_')) {
      const referrerId = parts[1].replace('ref_', '');
      const newUserId  = update.message.from.id;
      if (String(referrerId) !== String(newUserId)) {
        const { data: referrer } = await supabase
          .from('users').select('coins').eq('telegram_id', referrerId).single();
        if (referrer) {
          await supabase.from('users')
            .update({ coins: (referrer.coins || 0) + 5 }).eq('telegram_id', referrerId);
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: referrerId, text: `🎉 A friend joined Geco!\n\n⭐ +5 stars added to your balance!` })
          });
        }
      }
    }
    return res.json({ ok: true });
  }

  if (update.message?.text === '/paysupport') {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: update.message.from.id, text: 'For payment support, please contact @your_support_username' })
    });
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

app.post('/api/daily-status', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.json({ claimed_today: false, streak: 0 });
  try {
    const { data } = await supabase
      .from('users').select('last_daily_claim, daily_streak').eq('telegram_id', userId).single();
    const today = new Date().toISOString().slice(0, 10);
    res.json({ claimed_today: data?.last_daily_claim === today, streak: data?.daily_streak || 0 });
  } catch (e) { res.json({ claimed_today: false, streak: 0 }); }
});

app.post('/api/daily-claim', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid user' });
  try {
    const { data: user } = await supabase
      .from('users').select('coins, last_daily_claim, daily_streak').eq('telegram_id', userId).single();
    if (!user) return res.json({ success: false, error: 'User not found' });
    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (user.last_daily_claim === today) return res.json({ success: false, error: 'Already claimed today' });
    const streak = user.last_daily_claim === yesterday ? (user.daily_streak || 0) + 1 : 1;
    const reward = streak >= 7 ? 3 : streak >= 4 ? 2 : 1;
    await supabase.from('users').update({
      coins: (user.coins || 0) + reward, last_daily_claim: today, daily_streak: streak
    }).eq('telegram_id', userId);
    res.json({ success: true, reward, streak });
  } catch (e) {
    console.error('Daily claim error:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

app.post('/api/streak-bonus', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.status(400).json({ success: false });
  try {
    const { data: user } = await supabase
      .from('users').select('coins, daily_streak, last_streak_bonus').eq('telegram_id', userId).single();
    if (!user || user.daily_streak < 7) return res.json({ success: false, error: 'Streak not complete' });
    const week = Math.floor(Date.now() / (7 * 86400000));
    if (user.last_streak_bonus === week) return res.json({ success: false, error: 'Already claimed this week' });
    await supabase.from('users').update({ coins: (user.coins || 0) + 10, last_streak_bonus: week }).eq('telegram_id', userId);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'Server error' }); }
});

/* ══ START ══ */
startWaiting();
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Geco server running on port ${PORT}`));
