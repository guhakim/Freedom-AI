'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes } = require('./helpers/mockBackend');

const STATS = path.join(__dirname, '..', 'api', 'stats.js');

test('GET without a key is rejected, and with the wrong key is unauthorized', async () => {
  installMocks();
  process.env.ADMIN_STATS_KEY = 'right-key';
  const handler = freshHandler(STATS);

  let res = mockRes();
  await handler(mockReq({ method: 'GET', query: {} }), res);
  assert.equal(res.statusCode, 401);

  res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'wrong-key' } }), res);
  assert.equal(res.statusCode, 401);

  delete process.env.ADMIN_STATS_KEY;
});

// 회귀 테스트: 가입자 "수"만 보여주고 실제로 누가 가입했는지(이메일 목록)는 확인할
// 방법이 없었다 — 관리자 페이지에서 목록까지 보여주려면 API가 이메일 배열도 함께
// 내려줘야 한다.
test('GET with the correct key returns the signup count and the actual email list', async () => {
  const { kv } = installMocks();
  await kv.sadd('fa:stats:users', 'a@example.com');
  await kv.sadd('fa:stats:users', 'b@example.com');
  process.env.ADMIN_STATS_KEY = 'right-key';
  const handler = freshHandler(STATS);

  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'right-key' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.users, 2);
  assert.deepEqual(res.body.userEmails.sort(), ['a@example.com', 'b@example.com']);

  delete process.env.ADMIN_STATS_KEY;
});

test('POST records a pageview without requiring the admin key', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(STATS);
  const res = mockRes();

  await handler(mockReq({ method: 'POST', body: { page: 'app' } }), res);

  assert.equal(res.statusCode, 204);
  assert.equal(await kv.get('fa:stats:pageviews'), 1);
  assert.equal(await kv.get('fa:stats:pageviews:app'), 1);
});

// 회귀 테스트: 날짜별 방문 수를 관리자 페이지에서 보여주려면, 페이지뷰를 기록할 때마다
// KST 기준 오늘 날짜 카운터도 함께 올라가고, 조회 시 최신 날짜부터 내려와야 한다.
test('POST increments a per-day counter, and GET returns dailyStats newest-first', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(STATS);
  process.env.ADMIN_STATS_KEY = 'right-key';

  const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await handler(mockReq({ method: 'POST', body: { page: 'index' } }), mockRes());
  await handler(mockReq({ method: 'POST', body: { page: 'app' } }), mockRes());
  await kv.sadd('fa:stats:daily:dates', '2020-01-01');
  await kv.set('fa:stats:daily:2020-01-01', 5);

  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'right-key' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(await kv.get(`fa:stats:daily:${kstToday}`), 2);
  assert.deepEqual(res.body.dailyStats[0], { date: kstToday, count: 2 });
  assert.deepEqual(res.body.dailyStats[1], { date: '2020-01-01', count: 5 });

  delete process.env.ADMIN_STATS_KEY;
});

// 회귀 테스트: 월별 방문 수는 더 이상 별도 카운터를 두지 않고, 같은 달에 속한 일별
// 카운터들을 합산해서 계산한다 — 일별/월별이 서로 다른 시점에 따로 증가하다 어긋나는
// 일(과거에 실제로 겪었던 1건 차이 같은 것)이 구조적으로 생길 수 없어야 한다.
test('monthlyStats is derived by summing dailyStats within the same month, so it can never drift out of sync', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(STATS);
  process.env.ADMIN_STATS_KEY = 'right-key';

  for (const [date, count] of [['2026-09-17', 84], ['2026-09-18', 42], ['2026-09-19', 2], ['2020-01-05', 99]]) {
    await kv.sadd('fa:stats:daily:dates', date);
    await kv.set(`fa:stats:daily:${date}`, count);
  }

  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'right-key' } }), res);

  assert.equal(res.statusCode, 200);
  const sep = res.body.monthlyStats.find(m => m.month === '2026-09');
  assert.equal(sep.count, 84 + 42 + 2); // 별도 카운터 없이 일별 값을 합산한 값과 정확히 같아야 함
  const jan2020 = res.body.monthlyStats.find(m => m.month === '2020-01');
  assert.equal(jan2020.count, 99);

  delete process.env.ADMIN_STATS_KEY;
});

// 회귀 테스트: 오늘 아직 방문이 0건이면 fa:stats:daily:dates 집합에 오늘 날짜 키 자체가
// 없다 — 그렇다고 관리자 페이지에 오늘이 아예 안 보이면 "카운터가 고장났나" 싶어 보인다.
// 항상 목록 맨 앞에 오늘을 0건으로라도 채워 넣어야 한다.
test('GET always includes today in dailyStats even with zero visits so far, instead of omitting it', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(STATS);
  process.env.ADMIN_STATS_KEY = 'right-key';
  const kstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 어제까지만 방문 기록이 있고 오늘은 전혀 없는 상태를 흉내낸다
  await kv.sadd('fa:stats:daily:dates', '2020-01-01');
  await kv.set('fa:stats:daily:2020-01-01', 5);

  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'right-key' } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.dailyStats[0], { date: kstToday, count: 0 });

  delete process.env.ADMIN_STATS_KEY;
});
