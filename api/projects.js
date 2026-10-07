'use strict';

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const { verifyEmail: verifyOwner } = require('../lib/auth');

// api/rename-room.js·api/team.js가 방 이름을 32자로 제한하므로 여기도 같아야 한다. 예전엔
// 64자까지 받아서, 33~64자 프로젝트는 만들 수는 있는데 이름 변경은 영원히 400으로 거절됐다.
const MAX_NAME = 32;
const MAX_PROJECTS = 30; // app.html의 MAX_PROJECTS와 같아야 함

// 토큰 검증은 대소문자를 구분하지 않는데(lib/auth.js) KV 키는 바이트 단위로 구분된다.
// 예전엔 같은 핸들러 안에서 통계용 키만 소문자로 만들고 프로젝트 키는 받은 값 그대로 써서,
// Foo@Bar.com으로 들어오면 foo@bar.com과 다른 칸을 읽고 썼다 — 목록이 조용히 비어 보였다.
const projectsKey = email => `fa:user:projects:${email.toLowerCase()}`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKv();
  const kvOk = kv && process.env.KV_REST_API_URL;

  if (req.method === 'GET') {
    const email = req.query?.email;
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    if (!(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });
    try {
      if (kvOk) await kv.sadd('fa:stats:users', email.toLowerCase());
      let projects = [];
      if (kvOk) {
        projects = (await kv.get(projectsKey(email)))
          // 소문자 키로 바꾸기 전에 저장된 목록은 받은 값 그대로의 키에 들어 있다.
          || (email !== email.toLowerCase() ? await kv.get(`fa:user:projects:${email}`) : null)
          || [];
      }
      res.json({ projects });
    } catch(e) {
      // 예전엔 실패를 삼키고 빈 목록을 200으로 돌려줬다. 사이드바가 "프로젝트 없음"으로
      // 보이고 거기서 하나라도 추가하면 그 한 개짜리 목록이 POST로 올라가 원래 목록을
      // 통째로 덮어쓴다 — 읽기 실패가 목록 삭제로 이어지는 경로였다.
      console.error('projects get', e);
      res.status(500).json({ error: 'server_error' });
    }
    return;
  }

  if (req.method === 'POST') {
    const { email, projects } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    if (!Array.isArray(projects)) return res.status(400).json({ error: 'projects array required' });
    if (!(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });
    const validated = projects
      .filter(p => typeof p === 'string' && p.length > 0 && p.length <= MAX_NAME)
      .slice(0, MAX_PROJECTS);
    try {
      if (kvOk) await kv.set(projectsKey(email), validated);
      res.json({ projects: validated });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).end();
};
