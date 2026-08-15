'use strict';

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKv();
  const kvOk = kv && process.env.KV_REST_API_URL;

  if (req.method === 'POST') {
    // 페이지뷰 기록 (누구나 호출 가능, 단순 카운터 증가만 수행)
    const page = req.body?.page === 'app' ? 'app' : 'index';
    if (kvOk) {
      try {
        await kv.incr('fa:stats:pageviews');
        await kv.incr(`fa:stats:pageviews:${page}`);
      } catch { /* ignore */ }
    }
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    const ADMIN_KEY = process.env.ADMIN_STATS_KEY;
    if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_STATS_KEY not configured' });
    if (req.query?.key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

    if (!kvOk) {
      return res.json({ kvConnected: false, users: 0, pageviews: 0, pageviewsIndex: 0, pageviewsApp: 0 });
    }
    try {
      const [users, pageviews, pageviewsIndex, pageviewsApp] = await Promise.all([
        kv.scard('fa:stats:users'),
        kv.get('fa:stats:pageviews'),
        kv.get('fa:stats:pageviews:index'),
        kv.get('fa:stats:pageviews:app'),
      ]);
      return res.json({
        kvConnected: true,
        users: users || 0,
        pageviews: Number(pageviews) || 0,
        pageviewsIndex: Number(pageviewsIndex) || 0,
        pageviewsApp: Number(pageviewsApp) || 0,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
