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

/* ══ GAME STATE (shared for all players) ══ */
let gameState = {
  phase: 'waiting',   /* waiting | countdown | running | crashed */
  countdown: 10,
  multiplier: 1.00,
  crashPoint: 1.00,
  startTime: null,
  roundId: Date.now(),
  bets: [],           /* { userId, username, avatar, amount, cashedAt, lost } */
};

let gameInterval = null;
let countdownInterval = null;

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function genCrash() {
  const r = Math.random();
  if (r < 0.45) return parseFloat((1 + Math.random() * 0.4).toFixed(2));
  if (r < 0.70) return parseFloat((1.4 + Math.random() * 0.8).toFixed(2));
  if (r < 0.88) return parseFloat((2.2 + Math.random() * 2.8).toFixed(2));
  if (r < 0.97) return parseFloat((5 + Math.random() * 10).toFixed(2));
  return parseFloat((15 + Math.random() * 35).toFixed(2));
}

function startWaiting() {
  gameState.phase = 'waiting';
  gameState.bets = [];
  gameState.multiplier = 1.00;
  gameState.roundId = Date.now();
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

  gameInterval = setInterval(() => {
    const elapsed = (Date.now() - gameState.startTime) / 1000;
    gameState.multiplier = parseFloat(
      Math.pow(Math.E, 0.12 * elapsed * Math.pow(elapsed, 0.3)).toFixed(2)
    );
    if (gameState.multiplier < 1) gameState.multiplier = 1;

    /* Auto cashout for bets */
    gameState.bets.forEach(bet => {
      if (!bet.cashedAt && !bet.lost && bet.autoCashout && gameState.multiplier >= bet.autoCashout) {
        bet.cashedAt = gameState.multiplier;
        creditWin(bet);
        broadcast({ type: 'cashout', userId: bet.userId, mult: bet.cashedAt });
      }
    });

    broadcast({ type: 'tick', mult: gameState.multiplier, bets: gameState.bets });

    if (gameState.multiplier >= gameState.crashPoint) {
      doCrash();
    }
  }, 100);
}

function doCrash() {
  clearInterval(gameInterval);
  gameState.phase = 'crashed';
  gameState.bets.forEach(bet => { if (!bet.cashedAt) bet.lost = true; });
  broadcast({ type: 'crashed', mult: gameState.crashPoint, bets: gameState.bets });
  saveCrashHistory(gameState.crashPoint);
  setTimeout(startWaiting, 4000);
}

async function creditWin(bet) {
  try {
    const payout = Math.floor(bet.amount * bet.cashedAt);
    const { data: user } = await supabase
      .from('users').select('coins, stars_won').eq('telegram_id', bet.userId).single();
    if (user) {
      const profit = payout - bet.amount;
      await supabase.from('users').update({
        coins: (user.coins || 0) + payout,
        stars_won: (user.stars_won || 0) + Math.max(0, profit)
      }).eq('telegram_id', bet.userId);
    }
  } catch (e) { console.error('Credit error:', e); }
}

async function saveCrashHistory(point) {
  try {
    await supabase.from('crash_history').insert({ crash_point: point, created_at: new Date().toISOString() });
  } catch (e) {}
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

/* ══ WEBSOCKET CONNECTION ══ */
wss.on('connection', (ws) => {
  /* Send current state immediately on connect */
  ws.send(JSON.stringify({ type: 'state', game: getPublicState() }));

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'bet') {
        const { userId, username, photoUrl, amount, autoCashout, initData } = data;
        if (!userId || !amount || amount < 50) return;

        /* Check balance */
        const { data: user } = await supabase
          .from('users').select('coins').eq('telegram_id', userId).single();
        if (!user || user.coins < amount) {
          ws.send(JSON.stringify({ type: 'bet_error', msg: 'Insufficient balance' }));
          return;
        }

        /* Check if already bet this round */
        const existing = gameState.bets.find(b => String(b.userId) === String(userId));
        if (existing) {
          ws.send(JSON.stringify({ type: 'bet_error', msg: 'Already bet this round' }));
          return;
        }

        /* Can only bet during waiting or countdown */
        if (gameState.phase !== 'waiting' && gameState.phase !== 'countdown') {
          ws.send(JSON.stringify({ type: 'bet_error', msg: 'Round already started' }));
          return;
        }

        /* Deduct balance */
        await supabase.from('users')
          .update({ coins: user.coins - amount })
          .eq('telegram_id', userId);

        const bet = { userId, username, photoUrl: photoUrl || null, amount, autoCashout: autoCashout || null, cashedAt: null, lost: false };
        gameState.bets.push(bet);

        ws.send(JSON.stringify({ type: 'bet_ok', amount }));
        broadcast({ type: 'bets_update', bets: gameState.bets });
      }

      if (data.type === 'cashout') {
        const { userId } = data;
        const bet = gameState.bets.find(b => String(b.userId) === String(userId));
        if (!bet || bet.cashedAt || bet.lost || gameState.phase !== 'running') return;
        bet.cashedAt = gameState.multiplier;
        await creditWin(bet);
        ws.send(JSON.stringify({ type: 'cashout_ok', mult: bet.cashedAt, payout: Math.floor(bet.amount * bet.cashedAt) }));
        broadcast({ type: 'cashout', userId, mult: bet.cashedAt });
      }

    } catch (e) { console.error('WS message error:', e); }
  });
});

/* ══ HTTP ENDPOINTS ══ */
app.get('/', (req, res) => res.json({ status: 'Orbit Crash running' }));

function getUserData(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user')); } catch { return null; }
}
function getUserId(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user'))?.id; } catch { return null; }
}

app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.json({ coins: 1000 });
  const userInfo = getUserData(initData);
  const userId = userInfo?.id;
  if (!userId) return res.json({ coins: 1000 });
  try {
    const { data: existing } = await supabase
      .from('users').select('coins, stars_won').eq('telegram_id', userId).single();
    if (existing) {
      await supabase.from('users')
        .update({ first_name: userInfo?.first_name || null, username: userInfo?.username || null })
        .eq('telegram_id', userId);
      return res.json({ coins: existing.coins || 1000, stars_won: existing.stars_won || 0 });
    }
    const { data: newUser } = await supabase.from('users')
      .insert({ telegram_id: userId, first_name: userInfo?.first_name, username: userInfo?.username, coins: 1000, stars_won: 0 })
      .select().single();
    return res.json({ coins: newUser?.coins || 1000, stars_won: 0 });
  } catch (e) { return res.json({ coins: 1000 }); }
});

app.post('/api/balance', async (req, res) => {
  const userId = getUserId(req.body.initData);
  if (!userId) return res.json({ coins: 0 });
  const { data } = await supabase.from('users').select('coins, stars_won').eq('telegram_id', userId).single();
  res.json({ coins: data?.coins || 0, stars_won: data?.stars_won || 0 });
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase.from('users')
      .select('telegram_id, username, stars_won')
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Orbit Crash Stars',
        description: `Top up ${stars} stars to play Orbit Crash`,
        payload: JSON.stringify({ userId, stars, ts: Date.now() }),
        provider_token: '', currency: 'XTR',
        prices: [{ label: `${stars} Stars`, amount: stars }]
      })
    });
    const data = await response.json();
    if (!data.ok) return res.status(500).json({ error: 'Invoice creation failed' });
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/webhook', async (req, res) => {
  const update = req.body;
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
    const starsAmount = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const { data: existing } = await supabase.from('payments').select('id').eq('charge_id', chargeId).single();
    if (!existing) {
      const { data: user } = await supabase.from('users').select('coins').eq('telegram_id', telegramUserId).single();
      await supabase.from('users').update({ coins: (user?.coins || 0) + starsAmount }).eq('telegram_id', telegramUserId);
      await supabase.from('payments').insert({ telegram_id: telegramUserId, stars: starsAmount, charge_id: chargeId, created_at: new Date().toISOString() });
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramUserId, text: `✅ Payment confirmed!\n\n⭐ +${starsAmount} stars added.\n\nReceipt: ${chargeId}` })
      });
    }
    return res.json({ ok: true });
  }
  if (update.message?.text?.startsWith('/start')) {
    const parts = update.message.text.split(' ');
    if (parts[1]?.startsWith('ref_')) {
      const referrerId = parts[1].replace('ref_', '');
      const newUserId = update.message.from.id;
      if (String(referrerId) !== String(newUserId)) {
        const { data: referrer } = await supabase.from('users').select('coins').eq('telegram_id', referrerId).single();
        if (referrer) {
          await supabase.from('users').update({ coins: (referrer.coins || 0) + 5 }).eq('telegram_id', referrerId);
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: referrerId, text: `🎉 A friend joined!\n\n⭐ +5 stars added!` })
          });
        }
      }
    }
    return res.json({ ok: true });
  }
  if (update.message?.text === '/paysupport') {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: update.message.from.id, text: 'For payment support contact @your_support' })
    });
    return res.json({ ok: true });
  }
  res.json({ ok: true });
});

/* Start game loop */
startWaiting();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Orbit Crash server on port ${PORT}`));
