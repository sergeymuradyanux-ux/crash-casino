const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

function getUserId(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user'));
    return user.id;
  } catch (e) { return null; }
}

function getUserData(initData) {
  try {
    const params = new URLSearchParams(initData);
    return JSON.parse(params.get('user'));
  } catch (e) { return null; }
}

app.get('/', (req, res) => res.json({ status: 'Orbit Crash API running' }));

app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.json({ coins: 1000 });
  const userInfo = getUserData(initData);
  const userId = userInfo?.id;
  if (!userId) return res.json({ coins: 1000 });
  const firstName = userInfo?.first_name || null;
  const userName = userInfo?.username || null;
  try {
    const { data: existing } = await supabase
      .from('users').select('coins, stars_won')
      .eq('telegram_id', userId).single();
    if (existing) {
      await supabase.from('users')
        .update({ first_name: firstName, username: userName })
        .eq('telegram_id', userId);
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
  const { initData } = req.body;
  const userId = getUserId(initData);
  if (!userId) return res.json({ coins: 0 });
  const { data } = await supabase.from('users')
    .select('coins, stars_won').eq('telegram_id', userId).single();
  res.json({ coins: data?.coins || 0, stars_won: data?.stars_won || 0 });
});

app.post('/api/bet', async (req, res) => {
  const { initData, betAmount, cashedOutAt } = req.body;
  const userId = getUserId(initData);
  if (!userId) return res.json({ ok: false });
  const won = cashedOutAt !== null && cashedOutAt !== undefined;
  const payout = won ? Math.floor(betAmount * cashedOutAt) : 0;
  const profit = payout - betAmount;
  try {
    const { data: user } = await supabase.from('users')
      .select('coins, stars_won').eq('telegram_id', userId).single();
    const currentCoins = user?.coins || 0;
    const currentStarsWon = user?.stars_won || 0;
    if (won) {
      await supabase.from('users')
        .update({ coins: currentCoins + payout, stars_won: currentStarsWon + Math.max(0, profit) })
        .eq('telegram_id', userId);
    }
    await supabase.from('transactions').insert({
      telegram_id: userId,
      description: won ? `Won x${cashedOutAt}` : 'Lost at crash',
      delta: won ? profit : -betAmount,
      bet: betAmount,
      cashed_out_at: cashedOutAt || null,
      won
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Bet error:', e);
    res.json({ ok: false });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { data } = await supabase.from('users')
      .select('telegram_id, username, stars_won')
      .order('stars_won', { ascending: false })
      .limit(20);
    res.json({ rows: data || [] });
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.json({ rows: [] });
  }
});

app.post('/api/create-invoice', async (req, res) => {
  const { initData, stars } = req.body;
  const validAmounts = [100, 200, 500, 1000, 2000, 5000];
  if (!validAmounts.includes(stars)) return res.status(400).json({ error: 'Invalid amount' });
  const userId = getUserId(initData);
  if (!userId) return res.status(400).json({ error: 'Invalid user' });
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Orbit Crash Stars',
          description: `Top up ${stars} stars to play Orbit Crash`,
          payload: JSON.stringify({ userId, stars, ts: Date.now() }),
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: `${stars} Stars`, amount: stars }]
        })
      }
    );
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
    });
    return res.json({ ok: true });
  }

  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const telegramUserId = update.message.from.id;
    const starsAmount = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const { data: existing } = await supabase
      .from('payments').select('id').eq('charge_id', chargeId).single();
    if (!existing) {
      const { data: user } = await supabase
        .from('users').select('coins').eq('telegram_id', telegramUserId).single();
      await supabase.from('users')
        .update({ coins: (user?.coins || 0) + starsAmount })
        .eq('telegram_id', telegramUserId);
      await supabase.from('payments').insert({
        telegram_id: telegramUserId,
        stars: starsAmount,
        charge_id: chargeId,
        created_at: new Date().toISOString()
      });
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramUserId,
          text: `✅ Payment confirmed!\n\n⭐ +${starsAmount} stars added to your Orbit Crash balance.\n\nReceipt: ${chargeId}`
        })
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
        const { data: referrer } = await supabase
          .from('users').select('coins').eq('telegram_id', referrerId).single();
        if (referrer) {
          await supabase.from('users')
            .update({ coins: (referrer.coins || 0) + 5 })
            .eq('telegram_id', referrerId);
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: referrerId,
              text: `🎉 A friend joined via your link!\n\n⭐ +5 stars added to your balance!`
            })
          });
        }
      }
    }
    return res.json({ ok: true });
  }

  if (update.message?.text === '/paysupport') {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: update.message.from.id,
        text: 'For payment support, please contact @your_support_username'
      })
    });
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
