'use strict';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

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
