'use strict';
const { isAdmin } = require('../lib/auth');

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
  // POST(가입·페이지뷰 집계, 문의 접수)는 공개 폼에서 오므로 모든 출처를 허용한다. 다만
  // X-Admin-Key까지 모든 출처에 허용하면, 아무 제3자 페이지가 방문자 브라우저를 이용해
  // 관리자 키를 추측해 보고 적중 시 응답 본문(가입 이메일·문의 전문)까지 읽을 수 있다.
  // 관리자 키를 쓰는 요청은 같은 출처(admin.html)에서만 보내므로 그 헤더는 허용하지 않는다.
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

    // 저장하지 못했으면 실패로 응답한다 — 예전엔 항상 성공으로 응답해서 문의가 조용히 사라졌다
    if (!kvOk) return res.status(503).json({ error: 'storage_unavailable' });
    try {
      await kv.lpush('fa:contact:submissions', JSON.stringify(entry));
      await kv.ltrim('fa:contact:submissions', 0, MAX_STORED - 1);
    } catch (e) {
      console.error('contact: save failed', e);
      return res.status(503).json({ error: 'storage_unavailable' });
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const ADMIN_KEY = process.env.ADMIN_STATS_KEY;
    if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_STATS_KEY not configured' });
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!kvOk) return res.json({ submissions: [] });

    try {
      const raw = await kv.lrange('fa:contact:submissions', 0, MAX_STORED - 1);
      const submissions = (raw || []).map(r => {
        try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
      }).filter(Boolean);
      return res.json({ submissions });
    } catch (e) {
      console.error('contact: list failed', e);
      return res.status(500).json({ error: 'server_error' });
    }
  }

  res.status(405).end();
};
