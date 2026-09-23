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
      // daily 카운터 중 한쪽만 조용히 실패해도(예: 잘못된 KV 명령) 서로 영향 없이
      // 계속 동작하고, 어느 쪽이 실패했는지 Vercel 함수 로그에 남아 원인을 알 수 있게 한다.
      try {
        await kv.incr('fa:stats:pageviews');
        await kv.incr(`fa:stats:pageviews:${page}`);
      } catch (e) {
        console.error('stats: pageview counter failed', e);
      }
      try {
        // KST(UTC+9) 기준 날짜로 집계 — 한국 사용자 기준 "오늘"과 자정이 맞도록.
        // 월별 카운터는 따로 두지 않는다 — 일별 카운터와 별도로 증가시키면(예전 방식)
        // 둘 중 하나만 실패했을 때 두 값이 서로 어긋날 수 있었다. 조회 시 일별 값을
        // 월 단위로 합산해서 보여주면 애초에 어긋날 방법이 없다.
        const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        await kv.incr(`fa:stats:daily:${kstDate}`);
        await kv.sadd('fa:stats:daily:dates', kstDate);
      } catch (e) {
        console.error('stats: daily counter failed', e);
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
      const [users, userEmails, pageviews, pageviewsIndex, pageviewsApp, dailyDates] = await Promise.all([
        kv.scard('fa:stats:users'),
        kv.smembers('fa:stats:users'),
        kv.get('fa:stats:pageviews'),
        kv.get('fa:stats:pageviews:index'),
        kv.get('fa:stats:pageviews:app'),
        kv.smembers('fa:stats:daily:dates'),
      ]);

      // 알려진 모든 날짜의 카운트를 한 번에 읽어서(daily 표시용 + monthly 합산용 공용)
      // 일별/월별이 서로 다른 시점에 따로 갱신되다 어긋나는 일이 구조적으로 없게 한다.
      const allDates = (dailyDates || []).sort();
      const allDailyCounts = await Promise.all(allDates.map(async date => ({
        date,
        count: Number(await kv.get(`fa:stats:daily:${date}`)) || 0,
      })));

      // 최근 30일만, 최신순. 오늘 날짜는 방문이 아직 0건이라 키 자체가 없어도(=목록에
      // 안 잡혀도) 항상 보여준다 — 안 그러면 "오늘 카운터가 고장났나?" 싶어 보인다.
      const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let dailyStats = allDailyCounts.slice(-30).reverse();
      if (!dailyStats.some(d => d.date === todayKst)) {
        dailyStats = [{ date: todayKst, count: 0 }, ...dailyStats].slice(0, 30);
      }

      // 월별은 일별 값을 월 단위(앞 7글자 "YYYY-MM")로 합산해서 계산 — 최근 12개월.
      const monthlyMap = new Map();
      for (const { date, count } of allDailyCounts) {
        const month = date.slice(0, 7);
        monthlyMap.set(month, (monthlyMap.get(month) || 0) + count);
      }
      const monthlyStats = [...monthlyMap.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 12)
        .map(([month, count]) => ({ month, count }));

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
