'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubFetch } = require('./helpers/mockBackend');

const REMOVE_BG = path.join(__dirname, '..', 'api', 'remove-bg.js');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('missing imageBase64 is rejected', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  await handler(mockReq({ body: {} }), res);

  assert.equal(res.statusCode, 400);
});

test('a non-data-URI image string is rejected', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  await handler(mockReq({ body: { imageBase64: 'not-an-image' } }), res);

  assert.equal(res.statusCode, 400);
});

test('missing HF_TOKEN configuration surfaces a clear 500, not a crash', async () => {
  installMocks();
  delete process.env.HF_TOKEN;
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);

  assert.equal(res.statusCode, 500);
});

test('a direct image/* response from the model is passed through as imageBase64', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => Buffer.from('fake-png-bytes'),
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.imageBase64.startsWith('data:image/png;base64,'));
});

// 실제 HF_TOKEN으로 mattmdjaga/segformer_b2_clothes를 직접 호출해 확인한 실제 응답
// 형태: 사람 부위별로 하나씩 마스크가 온다. "Background"는 피사체가 아니므로 제외하고
// 나머지 전부를 클라이언트가 합칠 수 있게 넘겨준다.
test('a JSON human-parsing response filters out "Background" and forwards the rest as masks[]', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'application/json' : null) },
    json: async () => ([
      { score: 0.99, label: 'Background', mask: 'YmFja2dyb3VuZA==' },
      { score: 0.97, label: 'Face', mask: 'ZmFjZQ==' },
      { score: 0.95, label: 'Hair', mask: 'aGFpcg==' },
    ]),
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.masks, [
    'data:image/png;base64,ZmFjZQ==',
    'data:image/png;base64,aGFpcg==',
  ]);
});

test('a response containing only "Background" (no subject detected) is a clear error, not an empty cutout', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'application/json' : null) },
    json: async () => ([{ score: 0.99, label: 'Background', mask: 'YmFja2dyb3VuZA==' }]),
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'no_subject_detected');
});

test('an HF 503 (model loading) is surfaced as a friendly model_loading error, not a generic 502', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: false, status: 503, text: async () => 'loading',
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'model_loading');
});

test('an unrecognized response shape fails loudly (502) instead of silently returning garbage', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'text/plain' : null) },
    text: async () => 'unexpected',
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 502);
});

test('rate limit blocks the 6th request within a minute from the same IP', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => Buffer.from('x'),
  }));
  const handler = freshHandler(REMOVE_BG);

  try {
    let last;
    for (let i = 0; i < 6; i++) {
      const res = mockRes();
      await handler(mockReq({ headers: { 'x-forwarded-for': '1.2.3.4' }, body: { imageBase64: TINY_PNG } }), res);
      last = res;
    }
    assert.equal(last.statusCode, 429);
  } finally { restoreFetch(); }
});
