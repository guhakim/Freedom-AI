'use strict';
const express = require('express');

const app = express();
app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'freedom-ai-hf-server' }));

// 상시 실행되는 서버라 인스턴스가 재사용되므로, KV 없이 메모리 안에서만
// 레이트리밋을 관리해도 충분하다 (Vercel 서버리스처럼 인스턴스가 매번 사라지지 않음).
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// 원래 Vercel 함수들처럼 엔드포인트별로 독립된 한도를 준다(합쳐서 5개가 아니라 각각 5개).
const hitsByIpAndEndpoint = new Map();
function checkRateLimit(ip, endpoint) {
  const key = `${endpoint}:${ip}`;
  const now = Date.now();
  const hits = (hitsByIpAndEndpoint.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  hitsByIpAndEndpoint.set(key, hits);
  return hits.length <= RATE_LIMIT_MAX;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

app.post('/remove-bg', async (req, res) => {
  if (!checkRateLimit(clientIp(req), 'remove-bg')) {
    return res.status(429).json({ error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const match = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(imageBase64);
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
      }
    );

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      console.error('HF remove-bg error:', hfRes.status, errText);
      if (hfRes.status === 503) {
        return res.status(503).json({ error: 'model_loading', message: '모델 로딩 중입니다 (20-30초 후 다시 시도해주세요)' });
      }
      return res.status(502).json({ error: errText });
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/ai-transform', async (req, res) => {
  if (!checkRateLimit(clientIp(req), 'ai-transform')) {
    return res.status(429).json({ error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const { imageBase64, prompt } = req.body || {};
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });

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
      return res.status(502).json({ error: errText });
    }

    const buf = Buffer.from(await hfRes.arrayBuffer());
    const contentType = hfRes.headers.get('content-type') || 'image/jpeg';
    res.json({ imageBase64: `data:${contentType};base64,${buf.toString('base64')}` });

  } catch (e) {
    console.error('AI transform error:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`freedom-ai-hf-server listening on ${PORT}`));
