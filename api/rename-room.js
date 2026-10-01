'use strict';
const { isValidRoomId, verifyEmail, getMembers } = require('../lib/auth');

const MAX_ROOMID = 32;

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방)는 멤버만 이름을 바꿀 수 있다.
// 아직 비공개 전환 안 된(오픈) 방은 지금까지처럼 누구나 가능.
async function checkAccess(kv, req, roomId, email) {
  const members = await getMembers(kv, roomId);
  if (!members) return { ok: true, members: null };
  if (!(await verifyEmail(req, email))) return { ok: false };
  return { ok: members.includes(email.toLowerCase()), members };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { oldRoomId, newRoomId, email } = req.body || {};
  if (!isValidRoomId(oldRoomId)) return res.status(400).json({ error: 'oldRoomId required' });
  if (!isValidRoomId(newRoomId) || !newRoomId.trim() || newRoomId.length > MAX_ROOMID) {
    return res.status(400).json({ error: 'invalid_newRoomId' });
  }
  if (oldRoomId === newRoomId) return res.json({ ok: true });

  const kv = await getKv();
  if (!kv || !process.env.KV_REST_API_URL) {
    // KV 미설정 환경: 서버에 옮길 데이터가 없으므로(로컬 저장만 사용) 그대로 성공 처리
    return res.json({ ok: true, migrated: false });
  }

  try {
    const access = await checkAccess(kv, req, oldRoomId, email);
    if (!access.ok) return res.status(403).json({ error: 'access_denied' });

    // 이름이 겹치면 남의(또는 이전) 방 내용을 덮어쓸 수 있으므로 반드시 차단
    const [newState, newMembers] = await Promise.all([
      kv.get(`fa:room:${newRoomId}`),
      kv.get(`fa:room:${newRoomId}:members`),
    ]);
    if (newState || newMembers) return res.status(409).json({ error: 'name_taken' });

    const oldState = await kv.get(`fa:room:${oldRoomId}`);
    if (oldState) {
      await kv.set(`fa:room:${newRoomId}`, oldState);
      await kv.del(`fa:room:${oldRoomId}`);
    }
    if (access.members) {
      await kv.set(`fa:room:${newRoomId}:members`, access.members);
      await kv.del(`fa:room:${oldRoomId}:members`);
    }
    res.json({ ok: true, migrated: true });
  } catch (e) {
    console.error('rename-room', e);
    res.status(500).json({ error: 'server_error' });
  }
};
