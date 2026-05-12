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
  cashoutInProgress.clear();
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

    /* auto-cashout check */
    for (const bet of gameState.bets) {
      if (
        !bet.cashedAt && !bet.lost &&
        bet.autoCashout &&
        gameState.multiplier >= bet.autoCashout &&
        !cashoutInProgress.has(String(bet.userId))
      ) {
        cashoutInProgress.add(String(bet.userId));
        bet.cashedAt = gameState.multiplier;
        const payout = Math.floor(bet.amount * bet.cashedAt);
        const profit = payout - bet.amount;
        try {
          const { data: user } = await supabase.from('users').select('coins, stars_won').eq('telegram_id', bet.userId).single();
          if (user) {
            await supabase.from('users').update({
              coins: (user.coins || 0) + payout,
              stars_won: (user.stars_won || 0) + Math.max(0, profit)
            }).eq('telegram_id', bet.userId);
            await supabase.from('transactions').insert({
              telegram_id: bet.userId, description: `Auto cashout x${bet.cashedAt}`,
              delta: profit, bet: bet.amount, cashed_out_at: bet.cashedAt, won: true
            });
          }
        } catch (e) {
          console.error('Auto cashout DB error:', e);
        } finally {
          cashoutInProgress.delete(String(bet.userId));
        }
        broadcast({ type: 'cashout_ok', userId: bet.userId, mult: bet.cashedAt, payout });
        broadcast({ type: 'cashout', userId: bet.userId, mult: bet.cashedAt });
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
        delta: -bet.amount, bet: bet.amount, cashed_out_at: null, won: false
      }).catch(() => {});
    }
  });

  broadcast({ type: 'crashed', mult: gameState.crashPoint, bets: gameState.bets });
  saveCrashHistory(gameState.crashPoint);
  setTimeout(startWaiting, 4000);
}

async function saveCrashHistory(point) {
  try {
    await supabase.from('crash_history').insert({ crash_point: point, created_at: new Date().toISOString() });
  } catch (e) {}
}

/* ══ WEBSOCKET ══ */
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

      if (data.type === 'ping') {
        sendTo(ws, { type: 'pong' });
        return;
      }

      if (data.type === 'bet') {
        const { userId, username, photoUrl, amount, autoCashout } = data;
        if (!userId || !amount || amount < 50) return sendTo(ws, { type: 'bet_error', msg: 'Invalid bet' });
        if (gameState.phase !== 'waiting' && gameState.phase !== 'countdown' && gameState.phase !== 'crashed')
          return sendTo(ws, { type: 'bet_error', msg: 'Round already started' });
        if (gameState.bets.find(b => String(b.userId) === String(userId)))
          return sendTo(ws, { type: 'bet_error', msg: 'Already bet this round' });

        const { data: user } = await supabase.from('users').select('coins').eq('telegram_id', userId).single();
        if (!user || user.coins < amount) return sendTo(ws, { type: 'bet_error', msg: 'Insufficient balance' });

        await supabase.from('users').update({ coins: user.coins - amount }).eq('telegram_id', userId);
        gameState.bets.push({ userId, username, photoUrl: photoUrl || null, amount, autoCashout: autoCashout ? parseFloat(autoCashout) : null, cashedAt: null, lost: false });
        sendTo(ws, { type: 'bet_ok', amount });
        broadcast({ type: 'bets_update', bets: gameState.bets });
        console.log(`Bet placed: user ${userId}, amount ${amount}`);
      }

      if (data.type === 'cashout') {
        const { userId } = data;
        if (gameState.phase !== 'running') return sendTo(ws, { type: 'cashout_error', msg: 'Game not running' });

        const bet = gameState.bets.find(b => String(b.userId) === String(userId));
        if (!bet) return sendTo(ws, { type: 'cashout_error', msg: 'No bet found' });
        if (bet.cashedAt) {
          const payout = Math.floor(bet.amount * bet.cashedAt);
          return sendTo(ws, { type: 'cashout_ok', mult: bet.cashedAt, payout });
        }
        if (bet.lost) return sendTo(ws, { type: 'cashout_error', msg: 'Round already crashed' });
        if (cashoutInProgress.has(String(userId))) return;

        cashoutInProgress.add(String(userId));
        const lockedMult = gameState.multiplier;
        bet.cashedAt = lockedMult;
        const payout = Math.floor(bet.amount * lockedMult);
        const profit = payout - bet.amount;

        broadcast({ type: 'cashout', userId, mult: lockedMult });

        try {
          const { data: user } = await supabase.from('users').select('coins, stars_won').eq('telegram_id', userId).single();
          if (user) {
            await supabase.from('users').update({
              coins: (user.coins || 0) + payout,
              stars_won: (user.stars_won || 0) + Math.max(0, profit)
            }).eq('telegram_id', userId);
            await supabase.from('transactions').insert({
              telegram_id: userId, description: `Won x${lockedMult}`,
              delta: profit, bet: bet.amount, cashed_out_at: lockedMult, won: true
            });
          }
        } catch (e) {
          console.error('Cashout DB error:', e);
        } finally {
          cashoutInProgress.delete(String(userId));
        }

        sendTo(ws, { type: 'cashout_ok', mult: lockedMult, payout });
        console.log(`Manual cashout: user ${userId} at x${lockedMult}, payout ${payout}`);

        const winBet = gameState.bets.find(b => String(b.userId) === String(userId));
        notifyWin(winBet?.username, userId, lockedMult, payout);
      }

    } catch (e) {
      console.error('WS message error:', e);
    }
  });

  ws.on('close', () => console.log('Client disconnected, total:', wss.clients.size));
  ws.on('error', (err) => console.error('WS client error:', err.message));
});

/* ══ HELPERS ══ */
function getUserData(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user')); }
  catch { return null; }
}

function getUserId(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user'))?.id; }
  catch { return null; }
}

/* getUserIdFlex — also accepts plain userId for desktop fallback */
function getUserIdFlex(body) {
  const fromInitData = getUserId(body.initData);
  if (fromInitData) return String(fromInitData);
  if (body.userId) return String(body.userId);
  return null;
}

/* ══ ANNOUNCE ══ */
const ANNOUNCE_CHANNEL = process.env.ANNOUNCE_CHANNEL || '@GecoCrashNews';

async function notifyWin(username, userId, mult, payout) {
  if (!ANNOUNCE_CHANNEL || mult < 3) return;
  const maskedId = String(userId).slice(0, 6) + '****';
  const name = username ? `@${username}` : `user ${maskedId}`;
  const text = `🏆 ${name} just won ⭐${payout.toLocaleString()} at ×${mult.toFixed(2)}!\n\n🚀 Play Geco Crash → @OrbitCrashBot\n💬 Join our chat → @GecoCrashChat`;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ANNOUNCE_CHANNEL, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

/* ══ REST ENDPOINTS ══ */
app.get('/', (req, res) => res.json({ status: 'Geco API running', clients: wss.clients.size }));

/* ── CASHOUT FALLBACK — works with both initData and plain userId ── */
app.post('/api/cashout-confirm', async (req, res) => {
  const userId = getUserIdFlex(req.body);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid user' });

  if (gameState.phase !== 'running') return res.json({ success: false, error: 'Game not running' });

  const bet = gameState.bets.find(b => String(b.userId) === userId);
  if (!bet) return res.json({ success: false, error: 'No bet found' });
  if (bet.cashedAt) return res.json({ success: true, mult: bet.cashedAt, payout: Math.floor(bet.amount * bet.cashedAt), alreadyDone: true });
  if (bet.lost) return res.json({ success: false, error: 'Already crashed' });
  if (cashoutInProgress.has(userId)) return res.json({ success: false, error: 'Processing' });

  cashoutInProgress.add(userId);
  const lockedMult = gameState.multiplier;
  bet.cashedAt = lockedMult;
  const payout = Math.floor(bet.amount * lockedMult);
  const profit = payout - bet.amount;

  broadcast({ type: 'cashout', userId, mult: lockedMult });

  try {
    const { data: user } = await supabase.from('users').select('coins, stars_won').eq('telegram_id', userId).single();
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
    res.json({ success: true, mult: lockedMult, payout });
  } finally {
    cashoutInProgress.delete(userId);
  }
});

app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.json({ coins: 1000 });
  const userInfo = getUserData(initData);
  const userId = userInfo?.id;
  if (!userId) return res.json({ coins: 1000 });
  const firstName = userInfo?.first_name || null;
  const userName = userInfo?.username || null;
  try {
    const { data: existing } = await supabase.from('users').select('coins, stars_won, invite_count, invite_earned').eq('telegram_id', userId).single();
    if (existing) {
      await supabase.from('users').update({ first_name: firstName, username: userName }).eq('telegram_id', userId);
      return res.json({ coins: existing.coins || 1000, stars_won: existing.stars_won || 0, invite_count: existing.invite_count || 0, invite_earned: existing.invite_earned || 0 });
    }
    const { data: newUser } = await supabase.from('users').insert({ telegram_id: userId, first_name: firstName, username: userName, coins: 1000, stars_won: 0, invite_count: 0, invite_earned: 0 }).select().single();
    return res.json({ coins: newUser?.coins || 1000, stars_won: 0, invite_count: 0, invite_earned: 0 });
  } catch (e) {
    console.error('User error:', e);
    return res.json({ coins: 1000 });
  }
});

app.post('/api/balance', async (req, res) => {
  const userId = getUserIdFlex(req.body);
  if (!userId) return res.json({ coins: 0 });
  try {
    const { data } = await supabase.from('users').select('coins, stars_won').eq('telegram_id', userId).single();
    res.json({ coins: data?.coins || 0, stars_won: data?.stars_won || 0 });
  } catch (e) { res.json({ coins: 0 }); }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('telegram_id, username, stars_won').order('stars_won', { ascending: false }).limit(20);
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
    const starsAmount = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const { data: existing } = await supabase.from('payments').select('id').eq('charge_id', chargeId).single();
    if (!existing) {
      const { data: user } = await supabase.from('users').select('coins').eq('telegram_id', telegramUserId).single();
      await supabase.from('users').update({ coins: (user?.coins || 0) + starsAmount }).eq('telegram_id', telegramUserId);
      await supabase.from('payments').insert({ telegram_id: telegramUserId, stars: starsAmount, charge_id: chargeId, created_at: new Date().toISOString() });
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramUserId, text: `✅ Payment confirmed!\n\n⭐ +${starsAmount} stars added to your Geco balance.\n\nReceipt: ${chargeId}` })
      });
    }
    return res.json({ ok: true });
  }

  if (update.message?.text?.startsWith('/start')) {
    const parts = update.message.text.split(' ');
    const chatId = update.message.from.id;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🦎 Welcome to Geco!\n\nPredict the drop, react fast, climb the leaderboard.\n\n⚡ Live rounds 24/7\n🏆 Global leaderboard\n📢 @GecoCrashNews`,
        reply_markup: { inline_keyboard: [[{ text: '🚀 Open Geco', web_app: { url: process.env.WEBAPP_URL || 'https://crash-casino.vercel.app' } }]] }
      })
    });
    if (parts[1]?.startsWith('ref_')) {
      const referrerId = parts[1].replace('ref_', '');
      if (String(referrerId) !== String(chatId)) {
        const { data: referrer } = await supabase.from('users').select('coins, invite_count, invite_earned').eq('telegram_id', referrerId).single();
        if (referrer) {
          await supabase.from('users').update({ coins: (referrer.coins || 0) + 5, invite_count: (referrer.invite_count || 0) + 1, invite_earned: (referrer.invite_earned || 0) + 5 }).eq('telegram_id', referrerId);
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
      body: JSON.stringify({ chat_id: update.message.from.id, text: 'For payment support, please contact @GecoCrashChat' })
    });
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

app.post('/api/daily-status', async (req, res) => {
  const userId = getUserIdFlex(req.body);
  if (!userId) return res.json({ claimed_today: false, streak: 0 });
  try {
    const { data } = await supabase.from('users').select('last_daily_claim, daily_streak').eq('telegram_id', userId).single();
    const today = new Date().toISOString().slice(0, 10);
    res.json({ claimed_today: data?.last_daily_claim === today, streak: data?.daily_streak || 0 });
  } catch (e) { res.json({ claimed_today: false, streak: 0 }); }
});

app.post('/api/daily-claim', async (req, res) => {
  const userId = getUserIdFlex(req.body);
  if (!userId) return res.status(400).json({ success: false, error: 'Invalid user' });
  try {
    const { data: user } = await supabase.from('users').select('coins, last_daily_claim, daily_streak').eq('telegram_id', userId).single();
    if (!user) return res.json({ success: false, error: 'User not found' });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (user.last_daily_claim === today) return res.json({ success: false, error: 'Already claimed today' });
    const streak = user.last_daily_claim === yesterday ? (user.daily_streak || 0) + 1 : 1;
    const reward = streak >= 7 ? 3 : streak >= 4 ? 2 : 1;
    await supabase.from('users').update({ coins: (user.coins || 0) + reward, last_daily_claim: today, daily_streak: streak }).eq('telegram_id', userId);
    res.json({ success: true, reward, streak });
  } catch (e) {
    console.error('Daily claim error:', e);
    res.json({ success: false, error: 'Server error' });
  }
});

app.post('/api/streak-bonus', async (req, res) => {
  const userId = getUserIdFlex(req.body);
  if (!userId) return res.status(400).json({ success: false });
  try {
    const { data: user } = await supabase.from('users').select('coins, daily_streak, last_streak_bonus').eq('telegram_id', userId).single();
    if (!user || user.daily_streak < 7) return res.json({ success: false, error: 'Streak not complete' });
    const week = Math.floor(Date.now() / (7 * 86400000));
    if (user.last_streak_bonus === week) return res.json({ success: false, error: 'Already claimed this week' });
    await supabase.from('users').update({ coins: (user.coins || 0) + 10, last_streak_bonus: week }).eq('telegram_id', userId);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'Server error' }); }
});

/* ══ BROADCAST MESSAGE TO ALL USERS ══ */
/* Protected by ADMIN_SECRET env variable */
app.post('/api/admin/broadcast', async (req, res) => {
  const { secret, message, addCoins } = req.body;

  /* Security check */
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'geco-admin-2024';
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  if (!message) return res.status(400).json({ success: false, error: 'No message provided' });

  try {
    /* Get all users */
    const { data: users, error } = await supabase
      .from('users')
      .select('telegram_id, coins, first_name');

    if (error || !users) return res.status(500).json({ success: false, error: 'DB error' });

    /* Add coins if specified */
    if (addCoins && addCoins > 0) {
      await supabase.rpc('add_coins_to_all', { amount: addCoins }).catch(async () => {
        /* fallback if RPC not available */
        for (const user of users) {
          await supabase.from('users')
            .update({ coins: (user.coins || 0) + addCoins })
            .eq('telegram_id', user.telegram_id);
        }
      });
    }

    /* Send Telegram message to each user */
    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: user.telegram_id,
            text: message,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🚀 Open Geco', web_app: { url: process.env.WEBAPP_URL || 'https://crash-casino.vercel.app' } }
              ]]
            }
          })
        });
        const d = await r.json();
        if (d.ok) sent++; else failed++;
      } catch (e) {
        failed++;
      }
      /* Small delay to avoid Telegram rate limiting */
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`Broadcast: sent=${sent} failed=${failed}`);
    res.json({ success: true, sent, failed, total: users.length });

  } catch (e) {
    console.error('Broadcast error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

/* ══ START ══ */
startWaiting();
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Geco server running on port ${PORT}`);
  const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  if (SELF_URL) {
    setInterval(() => { fetch(SELF_URL + '/').catch(() => {}); }, 4 * 60 * 1000);
    console.log(`Self-ping active → ${SELF_URL}`);
  }
});
