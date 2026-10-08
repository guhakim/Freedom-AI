'use strict';
const { isValidRoomId, verifyEmail, getMembers, acquireRoomLock, releaseRoomLock, MAX_ROOMID } = require('../lib/auth');

// 방 이름 한도는 lib/auth.js의 MAX_ROOMID와 같아야 한다

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

  let lock = null, lock2 = null;
  try {
    const access = await checkAccess(kv, req, oldRoomId, email);
    if (!access.ok) return res.status(403).json({ error: 'access_denied' });

    // 이름 변경은 방 상태를 옛 키에서 새 키로 옮기는 읽고-수정하고-쓰기다. api/action.js와
    // 같은 락을 잡아야, 옮기는 중에 들어온 액션이 이미 지운 옛 키에 상태를 되살려 써서 방이
    // 두 이름으로 갈라지고 그 사이 그린 내용이 사라지는 일을 막을 수 있다.
    //
    // 출발지만 잡으면 안 된다 — 목적지 이름으로 이미 누군가 작업 중이면, 그 요청이 자기가
    // 읽은(비어 있던) 상태를 나중에 써 넣어 방금 옮겨온 내용을 통째로 덮어쓴다. 두 방을
    // 모두 잠그되, 두 이름 변경이 서로를 기다리며 영원히 엇갈리지 않게 이름순으로 잡는다.
    const [lockA, lockB] = [oldRoomId, newRoomId].sort();
    lock = await acquireRoomLock(kv, `fa:room:${lockA}`);
    if (!lock) return res.status(503).json({ error: 'busy' });
    lock2 = await acquireRoomLock(kv, `fa:room:${lockB}`);
    if (!lock2) return res.status(503).json({ error: 'busy' });

    const oldState = await kv.get(`fa:room:${oldRoomId}`);
    // 만든 사람이 기록된 방은 그 사람만 이름을 바꿀 수 있다 (방이 통째로 다른 이름으로 옮겨져
    // 함께 쓰던 사람들 화면에서 사라지는 일을 막는다)
    if (oldState?.createdBy && !(await verifyEmail(req, email) && email.toLowerCase() === oldState.createdBy)) {
      return res.status(403).json({ error: 'owner_only' });
    }
    // 주인이 기록되지 않은 방은, 그 방에서 실제로 작업한 적 있는 사람만 이름을 바꿀 수 있다
    // (방 이름만 아는 제3자가 남의 방을 다른 이름으로 옮겨 사라지게 만드는 것을 막는다)
    if (!oldState?.createdBy && Array.isArray(oldState?.contributors) && oldState.contributors.length) {
      const me = typeof email === 'string' ? email.toLowerCase() : '';
      const ok = me && oldState.contributors.map(c => String(c).toLowerCase()).includes(me)
                 && await verifyEmail(req, email);
      if (!ok) return res.status(403).json({ error: 'owner_only' });
    }

    const newKey = `fa:room:${newRoomId}`;
    const newMembersKey = `${newKey}:members`;

    if (oldState) {
      // 이름이 겹치면 남의(또는 이전) 방 내용을 덮어쓴다. 읽어서 비었는지 확인한 뒤 쓰면 그
      // 사이에 다른 이름 변경이 끼어들 수 있었다 — 서로 다른 두 방을 같은 이름으로 동시에
      // 바꾸면 둘 다 ok를 받고 한쪽 방이 오류 없이 사라졌다. nx("없을 때만 쓰기")로 이름
      // 선점 자체를 원자적으로 만들어, 지는 쪽은 반드시 409를 받게 한다.
      if (!(await kv.set(newKey, oldState, { nx: true }))) {
        return res.status(409).json({ error: 'name_taken' });
      }
      // 상태는 없고 멤버 목록만 남은 이름일 수 있다(비공개였던 방). 그 경우 방금 한 선점을
      // 되돌리고 거절한다 — 안 그러면 남의 멤버 목록에 내 방 내용이 얹힌다.
      if (await kv.get(newMembersKey)) {
        await kv.del(newKey);
        return res.status(409).json({ error: 'name_taken' });
      }
      // 여기부터는 새 이름에 내용이 올라간 상태다. 중간에 실패하면 되돌려야 한다 —
      // 안 그러면 그 이름이 빈 방에 영구히 선점되거나(재시도마다 409), 옛 이름에는
      // 아무것도 없는데 사용자가 모르는 새 이름에만 내용이 남는다.
      try {
        await kv.del(`fa:room:${oldRoomId}`);
        if (access.members) {
          await kv.set(newMembersKey, access.members);
          await kv.del(`fa:room:${oldRoomId}:members`);
        }
      } catch (e) {
        console.error('rename-room rollback', e);
        try {
          await kv.set(`fa:room:${oldRoomId}`, oldState);
          if (access.members) await kv.set(`fa:room:${oldRoomId}:members`, access.members);
          await kv.del(newKey);
          await kv.del(newMembersKey);
        } catch { /* 되돌리기까지 실패하면 더 할 수 있는 게 없다 */ }
        return res.status(500).json({ error: 'server_error' });
      }
      return res.json({ ok: true, migrated: true });
    } else if (await kv.get(newKey) || await kv.get(newMembersKey)) {
      // 서버에 옮길 상태가 없는 방(로컬 저장만 쓰던 방)이라 선점할 값이 없다. 덮어쓸 내용도
      // 없으므로 읽어서 확인하는 것으로 충분하다.
      return res.status(409).json({ error: 'name_taken' });
    }

    if (access.members) {
      await kv.set(newMembersKey, access.members);
      await kv.del(`fa:room:${oldRoomId}:members`);
    }
    res.json({ ok: true, migrated: !!oldState });
  } catch (e) {
    console.error('rename-room', e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    await releaseRoomLock(kv, lock2);
    await releaseRoomLock(kv, lock);
  }
};
