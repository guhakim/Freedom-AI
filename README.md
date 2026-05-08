# Freedom AI

무한 캔버스 위에서 팀이 실시간으로 아이디어를 나누는 협업 툴입니다.  
브라우저만 있으면 어디서든 바로 시작할 수 있습니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 무한 캔버스 | 핀치 줌·패닝으로 끝없이 펼쳐지는 작업 공간 |
| 펜 & 지우개 | 3가지 굵기, 5가지 색상으로 자유롭게 드로잉 |
| 포스트잇 | 색깔 포스트잇 추가·이동·리사이즈·텍스트 편집 |
| 실시간 협업 | WebSocket 기반 커서·획·포스트잇 동기화 |
| Google 로그인 | Google 계정 또는 이름 입력으로 즉시 입장 |
| 룸 시스템 | URL `?room=xxx` 으로 팀별 독립 캔버스 분리 |
| 영속성 | 서버 재시작 후에도 데이터 보존 (`data.json`) |

---

## 기술 스택

- **Backend** — Node.js, `ws` (WebSocket)
- **Frontend** — Vanilla JS, Canvas API
- **Auth** — Google Identity Services (GIS) 팝업 방식
- **Storage** — JSON 파일 (`data.json`, gitignore 처리)

---

## 시작하기

### 1. 설치

```bash
npm install
```

### 2. 서버 실행

```bash
npm start          # 일반 실행
npm run dev        # 파일 변경 감지 자동 재시작
```

기본 포트: **3001**

### 3. 접속

```
http://localhost:3001        # 랜딩 페이지
http://localhost:3001/app.html?room=<룸ID>   # 캔버스 바로 접속
```

---

## Google 로그인 설정

Google OAuth 팝업 방식을 사용합니다. 로컬 개발 시 아래 URL을 Google Cloud Console에 등록해야 합니다.

**Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → 해당 클라이언트 ID**

**Authorized JavaScript origins 에 추가:**

```
http://localhost:3001
http://127.0.0.1:3001
```

Codespace 환경에서는 해당 Codespace URL도 추가:

```
https://<codespace-name>-3001.app.github.dev
```

> 설정 적용까지 최대 5분~수 시간 소요될 수 있습니다.

---

## 단축키

| 키 | 기능 |
|----|------|
| `P` | 펜 도구 |
| `E` | 지우개 |
| `S` | 포스트잇 |
| `H` | 이동(핸드) 도구 |
| `Ctrl + Z` | 실행 취소 |
| `+` / `-` | 줌 인/아웃 |
| `0` | 화면 중앙으로 초기화 |

---

## 프로젝트 구조

```
Freedom-AI/
├── server.js       # Node.js HTTP + WebSocket 서버
├── app.html        # 캔버스 앱 메인 페이지
├── index.html      # 랜딩 페이지
├── package.json
├── .gitignore
└── data.json       # 룸 데이터 (gitignore, 자동 생성)
```

---

## 서버 주요 정책

- **룸당 최대 스트로크** 1,000개
- **메시지당 최대 포인트** 500개
- **포스트잇 텍스트** 최대 10,000자
- **포스트잇 크기** 100px ~ 3,000px
- **빈 룸** 자동 정리 (마지막 사용자 퇴장 후 60초)
- **지우개** 종료 시 서버에서 겹치는 스트로크 즉시 제거
- **포스트잇 삭제** 생성자 본인만 가능

---

## 로드맵

### Phase 1 — 핵심 기능 ✅ 완료
- 무한 캔버스, 펜·지우개, 포스트잇, 실시간 협업 커서, Google 로그인

### Phase 2 — 확장 기능 (예정)
- 기본 도형 도구, 이미지 드래그 & 드롭, 협업 To-Do, 공유 링크, 모바일 최적화

### Phase 3 — AI 기능 (예정)
- AI 이미지 편집·생성, AI 아이디어 제안, 자동 레이아웃 정리, 버전 히스토리

---

© 2025 Freedom AI
