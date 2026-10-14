'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 수정이 실제로 동작하는지 확인할 때 "고친 줄을 일부러 되돌려 테스트가 깨지는지" 보는
// 변이 주입을 쓴다. 그 과정에서 되돌린 코드가 복원되지 않은 채 커밋된 적이 있어
// (기여자 저장·멤버 구성이 비활성화된 상태로 배포됨), 흔적이 남으면 테스트가 잡게 한다.
const ROOT = path.join(__dirname, '..');
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'api')).map(f => path.join('api', f)),
  path.join('lib', 'auth.js'),
].filter(f => f.endsWith('.js'));

const SUSPICIOUS = [
  { re: /\/\*\s*제거\s*\*\//, why: '변이 테스트가 코드를 지운 자리' },
  { re: /\bif\s*\(\s*false\s*\)/, why: '변이 테스트가 분기를 꺼둔 자리' },
  { re: /\bif\s*\(\s*true\s*\|\|/, why: '변이 테스트가 조건을 무력화한 자리' },
  { re: /SABOTAGE|TEMP\s*SABOTAGE/i, why: '의도적 고장 주입 흔적' },
];

test('no mutation-testing leftovers are committed in api/ or lib/', () => {
  const found = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const { re, why } of SUSPICIOUS) {
        if (re.test(line)) found.push(`${rel}:${i + 1}  ${why}\n    ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(found, [], '변이 테스트 흔적이 남아 있습니다:\n' + found.join('\n'));
});

// 소유권 보호의 두 축이 실제로 코드에 살아 있는지 — 둘 중 하나만 빠져도 보호가 무력해진다
test('the two halves of the ownership protection are both present', () => {
  const action = fs.readFileSync(path.join(ROOT, 'api', 'action.js'), 'utf8');
  const team = fs.readFileSync(path.join(ROOT, 'api', 'team.js'), 'utf8');
  assert.match(action, /state\.contributors\s*=\s*list;/,
    'action.js가 기여자 목록을 저장하지 않으면, team.js가 참고할 기록 자체가 남지 않는다');
  assert.match(team, /members\s*=\s*\[\.\.\.new Set\(\[\.\.\.contributors, me\]\)\];/,
    'team.js가 기여자를 멤버에 넣지 않으면, 비공개 전환 때 함께 쓰던 사람이 쫓겨난다');
});
