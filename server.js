import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;

// Verify request is really from Telegram
function verifyTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secret)
      .update(dataCheckString).digest('hex');
    return hash === expectedHash;
  } catch {
    return false;
  }
}

// Generate crash point (server controls this — players cannot cheat)
function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.40) return parseFloat((1 + Math.random() * 0.8).toFixed(2));
  if (r < 0.70) return parseFloat((1.8 + Math.random() * 1.5).toFixed(2));
  if (r < 0.90) return parseFloat((3.3 + Math.random() * 4).toFixed(2));
  return parseFloat((7 + Math.random() * 13).toFixed(2));
}

// GET or CREATE user
app.post('/api/user', async (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegramData(initData)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = JSON.parse(new URLSearchParams(initData).get('user'));

  const { data, error } = await supabase
    .from('users')
    .upsert(
      { telegram_id: user.id, username: user.first_name, coins: 1000 },
      { onConflict: 'telegram_id', ignoreDuplicates: true }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get user balance
app.post('/api/balance', async (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegramData(initData)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = JSON.parse(new URLSearchParams(initData).get('user'));

  const { data, error } = await supabase
    .from('users')
    .select('coins, username')
    .eq('telegram_id', user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Place a bet and get crash result
app.post('/api/bet', async (req, res) => {
  const { initData, betAmount, cashedOutAt } = req.body;
  if (!verifyTelegramData(initData)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = JSON.parse(new URLSearchParams(initData).get('user'));

  // Get current balance
  const { data: userData, error: fetchError } = await supabase
    .from('users')
    .select('coins')
    .eq('telegram_id', user.id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (userData.coins < betAmount) {
    return res.status(400).json({ error: 'Not enough coins' });
  }

  // Generate crash point
  const crashPoint = generateCrashPoint();
  const won = cashedOutAt !== null && cashedOutAt <= crashPoint;
  const winnings = won ? Math.floor(betAmount * cashedOutAt) : 0;
  const delta = won ? winnings - betAmount : -betAmount;
  const newBalance = userData.coins + delta;

  // Update balance
  const { error: updateError } = await supabase
    .from('users')
    .update({ coins: newBalance })
    .eq('telegram_id', user.id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  // Save transaction
  await supabase.from('transactions').insert({
    telegram_id: user.id,
    description: won
      ? `Win x${cashedOutAt} — crash at ${crashPoint}`
      : `Loss — crash at ${crashPoint}`,
    delta,
    bet: betAmount,
    crash_point: crashPoint,
    cashed_out_at: cashedOutAt,
    won
  });

  res.json({ crashPoint, won, delta, newBalance, winnings });
});

// Get transaction history
app.post('/api/history', async (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegramData(initData)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = JSON.parse(new URLSearchParams(initData).get('user'));

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('telegram_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Orbit Casino server running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
