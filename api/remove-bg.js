'use strict';

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const RATE_LIMIT_MAX    = 5;   // 요청 수
const RATE_LIMIT_WINDOW = 60;  // 초

// 서버리스 인스턴스 로컬 폴백 (KV 미설정 환경용, 완벽한 보장은 아님)
const localHits = new Map();
function checkLocalRateLimit(key) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW * 1000;
  const hits = (localHits.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  localHits.set(key, hits);
  return hits.length <= RATE_LIMIT_MAX;
}

async function checkRateLimit(ip) {
  const key = `fa:ratelimit:remove-bg:${ip}`;
  try {
    const kv = await getKv();
    if (kv && process.env.KV_REST_API_URL) {
      const count = await kv.incr(key);
      if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
      return count <= RATE_LIMIT_MAX;
    }
  } catch { /* KV 실패 시 로컬 폴백 */ }
  return checkLocalRateLimit(key);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await checkRateLimit(ip))) {
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
    // briaai/RMBG-1.4: 오픈 웨이트 배경제거 모델. image-segmentation 계열 모델의
    // HF 표준 추론 API는 원본 이미지 바이트를 그대로 요청 본문으로 받는다(JSON 아님).
    const hfRes = await fetch(
      'https://api-inference.huggingface.co/models/briaai/RMBG-1.4',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': mime,
          'X-Wait-For-Model': 'true',
        },
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

    // 모델에 따라 배경이 제거된 최종 이미지를 바로 돌려주는 경우
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await hfRes.arrayBuffer());
      return res.json({ imageBase64: `data:${contentType};base64,${buf.toString('base64')}` });
    }

    // image-segmentation 파이프라인의 표준 응답 형식: [{ score, label, mask }, ...]
    // (mask는 흑백 PNG의 base64) — 최종 합성은 원본 이미지를 들고 있는 클라이언트가 한다.
    if (contentType.includes('application/json')) {
      const data = await hfRes.json();
      const first = Array.isArray(data) ? data[0] : data;
      if (!first?.mask) {
        console.error('remove-bg unexpected JSON shape:', JSON.stringify(data).slice(0, 300));
        return res.status(502).json({ error: 'unexpected_model_response' });
      }
      return res.json({ maskBase64: `data:image/png;base64,${first.mask}` });
    }

    const raw = await hfRes.text();
    console.error('remove-bg unexpected content-type:', contentType, raw.slice(0, 200));
    return res.status(502).json({ error: 'unexpected_model_response' });

  } catch (e) {
    console.error('remove-bg error:', e);
    res.status(500).json({ error: e.message });
  }
};
