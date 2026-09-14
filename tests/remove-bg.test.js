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

test('a JSON image-segmentation response (mask array) is passed through as maskBase64', async () => {
  installMocks();
  process.env.HF_TOKEN = 'fake-hf-token';
  const restoreFetch = stubFetch(async () => ({
    ok: true,
    headers: { get: h => (h === 'content-type' ? 'application/json' : null) },
    json: async () => ([{ score: 0.99, label: 'foreground', mask: 'ZmFrZS1tYXNr' }]),
  }));
  const handler = freshHandler(REMOVE_BG);
  const res = mockRes();

  try {
    await handler(mockReq({ body: { imageBase64: TINY_PNG } }), res);
  } finally { restoreFetch(); }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.maskBase64, 'data:image/png;base64,ZmFrZS1tYXNr');
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
