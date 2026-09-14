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
    // 실제 HF_TOKEN으로 라이브 테스트해 확인한 내용: 예전 api-inference.huggingface.co
    // 도메인은 아예 사라졌고(HF가 router 방식으로 전면 이전), briaai/RMBG-1.4 같은
    // 전용 배경제거 모델은 무료 hf-inference 프로바이더에서 "지원 안 함"으로 거부된다.
    // 대신 사람 인물 사진을 부위별(배경/얼굴/머리카락/옷 등)로 나눠주는 인물 파싱
    // 모델은 hf-inference에서 정상 동작한다 — "배경"을 제외한 나머지 부위를 전부
    // 합치면 인물 컷아웃과 동일한 효과를 낼 수 있다. (인물 사진 기준 — 사람이 아닌
    // 피사체에는 잘 안 맞을 수 있음)
    const hfRes = await fetch(
      'https://router.huggingface.co/hf-inference/models/mattmdjaga/segformer_b2_clothes',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': mime,
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

    // 다른 모델로 바뀌어 배경이 제거된 최종 이미지를 바로 돌려주는 경우도 방어적으로 처리
    if (contentType.startsWith('image/')) {
      const buf = Buffer.from(await hfRes.arrayBuffer());
      return res.json({ imageBase64: `data:${contentType};base64,${buf.toString('base64')}` });
    }

    // image-segmentation 파이프라인의 표준 응답: [{ score, label, mask }, ...] — 사람 부위별로
    // 하나씩 온다. "Background" 라벨만 빼고 나머지 마스크를 전부 클라이언트로 보내면,
    // 거기서 하나로 합쳐 원본 이미지에 알파로 입힌다.
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
};
