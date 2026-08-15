'use strict';

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;
const MAX_STORED = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 60;
const localHits = new Map();
function checkLocalRateLimit(key) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW * 1000;
  const hits = (localHits.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  localHits.set(key, hits);
  return hits.length <= RATE_LIMIT_MAX;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKv();
  const kvOk = kv && process.env.KV_REST_API_URL;

  if (req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    let allowed = true;
    if (kvOk) {
      try {
        const key = `fa:ratelimit:contact:${ip}`;
        const count = await kv.incr(key);
        if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
        allowed = count <= RATE_LIMIT_MAX;
      } catch { allowed = checkLocalRateLimit(`contact:${ip}`); }
    } else {
      allowed = checkLocalRateLimit(`contact:${ip}`);
    }
    if (!allowed) return res.status(429).json({ error: 'rate_limited' });

    const { name, email, message } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) {
      return res.status(400).json({ error: 'invalid_name' });
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE) {
      return res.status(400).json({ error: 'invalid_message' });
    }

    const entry = {
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
      createdAt: new Date().toISOString(),
    };

    if (kvOk) {
      try {
        await kv.lpush('fa:contact:submissions', JSON.stringify(entry));
        await kv.ltrim('fa:contact:submissions', 0, MAX_STORED - 1);
      } catch { /* 저장 실패해도 사용자에게는 성공으로 응답 */ }
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const ADMIN_KEY = process.env.ADMIN_STATS_KEY;
    if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_STATS_KEY not configured' });
    if (req.query?.key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
    if (!kvOk) return res.json({ submissions: [] });

    try {
      const raw = await kv.lrange('fa:contact:submissions', 0, MAX_STORED - 1);
      const submissions = (raw || []).map(r => {
        try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
      }).filter(Boolean);
      return res.json({ submissions });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
