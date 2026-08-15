'use strict';

async function getKv() {
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
  const key = `fa:ratelimit:ai-transform:${ip}`;
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

  const { imageBase64, prompt } = req.body || {};
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });

  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not configured' });

  try {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const hfRes = await fetch(
      'https://api-inference.huggingface.co/models/timbrooks/instruct-pix2pix',
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
      console.error('HF API error:', hfRes.status, errText);
      // 모델 로딩 중이면 클라이언트에 재시도 안내
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
};
