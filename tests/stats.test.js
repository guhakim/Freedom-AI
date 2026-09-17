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

// 회귀 테스트: 월별 방문 수도 일별과 같은 방식(KST 기준, 최신순)으로 집계·조회돼야 한다.
test('POST increments a per-month counter, and GET returns monthlyStats newest-first', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(STATS);
  process.env.ADMIN_STATS_KEY = 'right-key';

  const kstThisMonth = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);

  await handler(mockReq({ method: 'POST', body: { page: 'index' } }), mockRes());
  await handler(mockReq({ method: 'POST', body: { page: 'app' } }), mockRes());
  await kv.sadd('fa:stats:monthly:months', '2020-01');
  await kv.set('fa:stats:monthly:2020-01', 99);

  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: { key: 'right-key' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(await kv.get(`fa:stats:monthly:${kstThisMonth}`), 2);
  assert.deepEqual(res.body.monthlyStats[0], { month: kstThisMonth, count: 2 });
  assert.deepEqual(res.body.monthlyStats[1], { month: '2020-01', count: 99 });

  delete process.env.ADMIN_STATS_KEY;
});
