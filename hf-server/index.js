'use strict';
const express = require('express');

const app = express();
// Render 프록시가 붙인 X-Forwarded-For의 마지막 값을 클라이언트 IP로 쓴다(req.ip). 예전엔 첫
// 번째 값을 써서, 요청마다 헤더를 바꿔 보내면 IP별 한도를 얼마든지 우회할 수 있었다.
app.set('trust proxy', 1);

// 이 앱 페이지에서 오는 요청만 받는다 (다른 사이트가 이 서버로 HF 할당량을 쓰지 못하게)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://freedomai-app.vercel.app,http://localhost:3000,http://localhost:3001')
  .split(',').map(s => s.trim()).filter(Boolean);

// CORS는 body 파싱보다 먼저 — 그래야 본문이 너무 커서 거부될 때도 브라우저가 에러 응답을
// 읽을 수 있다 (안 그러면 원인 모를 "Failed to fetch"만 보였다)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST' && !ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'forbidden_origin' });
  next();
});
app.use(express.json({ limit: '15mb' }));

app.get('/', (req, res) => res.json({ ok: true, service: 'freedom-ai-hf-server' }));

// 상시 실행되는 서버라 인스턴스가 재사용되므로, KV 없이 메모리 안에서만
// 레이트리밋을 관리해도 충분하다 (Vercel 서버리스처럼 인스턴스가 매번 사라지지 않음).
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// 원래 Vercel 함수들처럼 엔드포인트별로 독립된 한도를 준다(합쳐서 5개가 아니라 각각 5개).
const hitsByIpAndEndpoint = new Map();
// IP를 바꿔가며 보내는 경우까지 막기 위한 서버 전체 한도 (분당 HF 호출 수)
const GLOBAL_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT || 60);
let globalHits = [];
function checkRateLimit(ip, endpoint) {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (globalHits.length >= GLOBAL_LIMIT_MAX) return false;
  const key = `${endpoint}:${ip}`;
  const hits = (hitsByIpAndEndpoint.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) { hitsByIpAndEndpoint.set(key, hits); return false; }
  hits.push(now); globalHits.push(now);
  hitsByIpAndEndpoint.set(key, hits);
  return true;
}
// 오래된 IP 기록을 주기적으로 지운다 (안 지우면 IP가 바뀔 때마다 메모리가 계속 늘었다)
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of hitsByIpAndEndpoint) {
    if (!hits.some(t => now - t < RATE_LIMIT_WINDOW_MS)) hitsByIpAndEndpoint.delete(k);
  }
}, RATE_LIMIT_WINDOW_MS).unref();
function clientIp(req) {
  return req.ip || 'unknown';
}
const HF_TIMEOUT_MS = 60 * 1000;
const VALID_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_CHARS = 14 * 1024 * 1024;

app.post('/remove-bg', async (req, res) => {
  if (!checkRateLimit(clientIp(req), 'remove-bg')) {
    return res.status(429).json({ error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const { imageBase64 } = req.body || {};
  if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: 'imageBase64 required' });

  const match = VALID_IMAGE.exec(imageBase64);
  if (!match) return res.status(400).json({ error: 'invalid_image' });
  const [, mime, base64Data] = match;

  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not configured' });

  try {
    // 사람 인물 파싱 모델로 "배경"을 제외한 부위 마스크를 받아 클라이언트에서 합성한다
    // (api/remove-bg.js와 동일한 방식 — 자세한 배경 설명은 그 파일 주석 참고)
    const hfRes = await fetch(
      'https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': mime },
        body: Buffer.from(base64Data, 'base64'),
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
      }
    );

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      console.error('HF remove-bg error:', hfRes.status, errText);
      if (hfRes.status === 503) {
        return res.status(503).json({ error: 'model_loading', message: '모델 로딩 중입니다 (20-30초 후 다시 시도해주세요)' });
      }
      return res.status(502).json({ error: 'model_error' });
    }

    const contentType = hfRes.headers.get('content-type') || '';

    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await hfRes.arrayBuffer());
      return res.json({ imageBase64: `data:${contentType};base64,${buf.toString('base64')}` });
    }

    if (contentType.includes('application/json')) {
      const data = await hfRes.json();
      if (!Array.isArray(data) || !data.length) {
        console.error('remove-bg unexpected JSON shape:', JSON.stringify(data).slice(0, 300));
        return res.status(502).json({ error: 'unexpected_model_response' });
      }
      const masks = data
        .filter(d => d.label !== 'Background' && typeof d.mask === 'string')
        .map(d => `data:image/png;base64,${d.mask}`);
      if (!masks.length) return res.status(502).json({ error: 'no_subject_detected' });
      return res.json({ masks });
    }

    const raw = await hfRes.text();
    console.error('remove-bg unexpected content-type:', contentType, raw.slice(0, 200));
    return res.status(502).json({ error: 'unexpected_model_response' });

  } catch (e) {
    console.error('remove-bg error:', e);
    res.status(e.name === 'TimeoutError' ? 504 : 500).json({ error: e.name === 'TimeoutError' ? 'timeout' : 'server_error' });
  }
});

app.post('/ai-transform', async (req, res) => {
  if (!checkRateLimit(clientIp(req), 'ai-transform')) {
    return res.status(429).json({ error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const { imageBase64, prompt } = req.body || {};
  if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_IMAGE_CHARS || !VALID_IMAGE.test(imageBase64)
      || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) {
    return res.status(400).json({ error: 'imageBase64 and prompt required' });
  }

  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not configured' });

  try {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 예전 api-inference.huggingface.co 도메인은 완전히 사라졌다 (remove-bg에서
    // 확인한 것과 동일한 이유) — router 방식으로 교체. 다만 instruct-pix2pix가
    // hf-inference 프로바이더에서 아직 지원되는지는 별도 확인이 필요할 수 있음.
    const hfRes = await fetch(
      'https://router.huggingface.co/hf-inference/models/timbrooks/instruct-pix2pix',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Wait-For-Model': 'true',
        },
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        body: JSON.stringify({
          inputs: base64Data,
          parameters: {
            prompt,
            num_inference_steps: 20,
            image_guidance_scale: 1.5,
            guidance_scale: 7.5,
          },
        }),
      }
    );

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      console.error('HF ai-transform error:', hfRes.status, errText);
      if (hfRes.status === 503) {
        return res.status(503).json({ error: 'model_loading', message: '모델 로딩 중입니다 (20-30초 후 다시 시도해주세요)' });
      }
      return res.status(502).json({ error: 'model_error' });
    }

    const buf = Buffer.from(await hfRes.arrayBuffer());
    const contentType = hfRes.headers.get('content-type') || 'image/jpeg';
    res.json({ imageBase64: `data:${contentType};base64,${buf.toString('base64')}` });

  } catch (e) {
    console.error('AI transform error:', e);
    res.status(e.name === 'TimeoutError' ? 504 : 500).json({ error: e.name === 'TimeoutError' ? 'timeout' : 'server_error' });
  }
});

// body 파싱 실패(너무 큼·깨진 JSON) 등도 HTML 스택트레이스 대신 JSON으로 응답
app.use((err, req, res, next) => {
  console.error('request error:', err.type || err.message);
  res.status(err.status || 500).json({ error: err.type || 'bad_request' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`freedom-ai-hf-server listening on ${PORT}`));
