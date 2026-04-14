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

/* ══ VERIFY TELEGRAM initData ══ */
function verifyTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const arr = [];
    params.forEach((v, k) => arr.push(`${k}=${v}`));
    arr.sort();
    const dataStr = arr.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const sig = crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
    return sig === hash;
  } catch (e) {
    return false;
  }
}

function getUserId(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user'));
    return user.id;
  } catch (e) {
    return null;
  }
}

/* ══ GET / CREATE USER ══ */
app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.json({ coins: 1000 });

  const userId = getUserId(initData);
  if (!userId) return res.json({ coins: 1000 });

  const { data, error } = await supabase
    .from('users')
    .upsert({ telegram_id: userId }, { onConflict: 'telegram_id', ignoreDuplicates: true })
    .select()
    .single();

  if (error) {
    const { data: existing } = await supabase
      .from('users')
      .select('coins')
      .eq('telegram_id', userId)
      .single();
    return res.json({ coins: existing?.coins || 1000 });
  }
  return res.json({ coins: data?.coins || 1000 });
});

/* ══ GET BALANCE ══ */
app.post('/api/balance', async (req, res) => {
  const { initData } = req.body;
  const userId = getUserId(initData);
  if (!userId) return res.json({ coins: 0 });

  const { data } = await supabase
    .from('users')
    .select('coins')
    .eq('telegram_id', userId)
    .single();
  res.json({ coins: data?.coins || 0 });
});

/* ══ SAVE BET RESULT ══ */
app.post('/api/bet', async (req, res) => {
  const { initData, betAmount, cashedOutAt } = req.body;
  const userId = getUserId(initData);
  if (!userId) return res.json({ ok: false });

  const won = cashedOutAt !== null && cashedOutAt !== undefined;
  const payout = won ? Math.floor(betAmount * cashedOutAt) : 0;
  const delta = payout - betAmount; // negative = loss, positive = profit

  /* Update user balance */
  const { data: user } = await supabase
    .from('users')
    .select('coins')
    .eq('telegram_id', userId)
    .single();

  const currentCoins = user?.coins || 0;

  if (won) {
    /* Credit winnings (bet was already deducted on frontend) */
    await supabase
      .from('users')
      .update({ coins: currentCoins + payout })
      .eq('telegram_id', userId);
  }
  /* If lost: bet was already deducted on frontend, nothing more to do */

  /* Log transaction */
  await supabase.from('transactions').insert({
    telegram_id: userId,
    description: won ? `Won ×${cashedOutAt}` : `Lost at crash`,
    delta,
    bet: betAmount,
    cashed_out_at: cashedOutAt || null,
    won,
  });

  res.json({ ok: true });
});

/* ══ CREATE TELEGRAM STARS INVOICE ══ */
app.post('/api/create-invoice', async (req, res) => {
  const { initData, stars } = req.body;

  /* Validate amount */
  const validAmounts = [100, 200, 500, 1000, 2000, 5000];
  if (!validAmounts.includes(stars)) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  /* Optional: verify initData in production */
  const userId = getUserId(initData);
  if (!userId) return res.status(400).json({ error: 'Invalid user' });

  try {
    /* Call Telegram Bot API to create invoice link */
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Orbit Crash Stars',
          description: `Top up ${stars} stars to play Orbit Crash`,
          payload: JSON.stringify({ userId, stars, ts: Date.now() }),
          provider_token: '', /* Empty for Telegram Stars */
          currency: 'XTR',
          prices: [{ label: `${stars} Stars`, amount: stars }]
        })
      }
    );

    const data = await response.json();
    if (!data.ok) {
      console.error('Telegram invoice error:', data);
      return res.status(500).json({ error: 'Invoice creation failed' });
    }

    res.json({ invoiceLink: data.result });
  } catch (e) {
    console.error('Invoice error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ══ TELEGRAM WEBHOOK — handles pre_checkout + successful_payment ══ */
app.post('/webhook', async (req, res) => {
  const update = req.body;
  console.log('Webhook update:', JSON.stringify(update));

  /* Step 1: Must approve pre_checkout within 10 seconds */
  if (update.pre_checkout_query) {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true
        })
      }
    );
    return res.json({ ok: true });
  }

  /* Step 2: Payment confirmed — credit user balance */
  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const telegramUserId = update.message.from.id;
    const starsAmount = payment.total_amount; /* In XTR, no decimal */
    const chargeId = payment.telegram_payment_charge_id;

    /* Prevent double-crediting */
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('charge_id', chargeId)
      .single();

    if (!existing) {
      /* Credit the user */
      const { data: user } = await supabase
        .from('users')
        .select('coins')
        .eq('telegram_id', telegramUserId)
        .single();

      const currentCoins = user?.coins || 0;
      await supabase
        .from('users')
        .update({ coins: currentCoins + starsAmount })
        .eq('telegram_id', telegramUserId);

      /* Log payment */
      await supabase.from('payments').insert({
        telegram_id: telegramUserId,
        stars: starsAmount,
        charge_id: chargeId,
        created_at: new Date().toISOString()
      });

      /* Notify user via bot message */
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramUserId,
            text: `✅ Payment confirmed!\n\n⭐ +${starsAmount} stars added to your Orbit Crash balance.\n\nReceipt: ${chargeId}`
          })
        }
      );
    }
    return res.json({ ok: true });
  }

  /* Handle /paysupport command (required by Telegram) */
  if (update.message?.text === '/paysupport') {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: update.message.from.id,
          text: 'For payment support, contact @your_support_username or use /refund <receipt_id>'
        })
      }
    );
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

/* ══ HEALTH CHECK ══ */
app.get('/', (req, res) => res.json({ status: 'Orbit Crash API running' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
