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
      // 두 그룹을 따로 try/catch한다 — 예전부터 쓰던 pageviews 카운터와, 나중에 추가된
      // daily/monthly 카운터 중 한쪽만 조용히 실패해도(예: 잘못된 KV 명령) 서로 영향 없이
      // 계속 동작하고, 어느 쪽이 실패했는지 Vercel 함수 로그에 남아 원인을 알 수 있게 한다.
      try {
        await kv.incr('fa:stats:pageviews');
        await kv.incr(`fa:stats:pageviews:${page}`);
      } catch (e) {
        console.error('stats: pageview counter failed', e);
      }
      try {
        // KST(UTC+9) 기준 날짜로 집계 — 한국 사용자 기준 "오늘"과 자정이 맞도록.
        const kstIso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
        const kstDate  = kstIso.slice(0, 10);
        const kstMonth = kstIso.slice(0, 7);
        await kv.incr(`fa:stats:daily:${kstDate}`);
        await kv.sadd('fa:stats:daily:dates', kstDate);
        await kv.incr(`fa:stats:monthly:${kstMonth}`);
        await kv.sadd('fa:stats:monthly:months', kstMonth);
      } catch (e) {
        console.error('stats: daily/monthly counter failed', e);
      }
    }
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    const ADMIN_KEY = process.env.ADMIN_STATS_KEY;
    if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_STATS_KEY not configured' });
    if (req.query?.key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

    if (!kvOk) {
      return res.json({ kvConnected: false, users: 0, pageviews: 0, pageviewsIndex: 0, pageviewsApp: 0, dailyStats: [], monthlyStats: [] });
    }
    try {
      const [users, userEmails, pageviews, pageviewsIndex, pageviewsApp, dailyDates, monthlyMonths] = await Promise.all([
        kv.scard('fa:stats:users'),
        kv.smembers('fa:stats:users'),
        kv.get('fa:stats:pageviews'),
        kv.get('fa:stats:pageviews:index'),
        kv.get('fa:stats:pageviews:app'),
        kv.smembers('fa:stats:daily:dates'),
        kv.smembers('fa:stats:monthly:months'),
      ]);
      // 최근 30일 / 최근 12개월만, 최신순으로
      const recentDates = (dailyDates || []).sort().slice(-30).reverse();
      const dailyStats = await Promise.all(recentDates.map(async date => ({
        date,
        count: Number(await kv.get(`fa:stats:daily:${date}`)) || 0,
      })));
      const recentMonths = (monthlyMonths || []).sort().slice(-12).reverse();
      const monthlyStats = await Promise.all(recentMonths.map(async month => ({
        month,
        count: Number(await kv.get(`fa:stats:monthly:${month}`)) || 0,
      })));
      return res.json({
        kvConnected: true,
        users: users || 0,
        userEmails: (userEmails || []).sort(),
        pageviews: Number(pageviews) || 0,
        pageviewsIndex: Number(pageviewsIndex) || 0,
        pageviewsApp: Number(pageviewsApp) || 0,
        dailyStats,
        monthlyStats,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
