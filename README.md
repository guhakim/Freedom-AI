# Freedom AI

실시간 협업 무한 캔버스 툴 — 브라우저만 있으면 바로 시작, 링크 공유로 팀과 함께 그립니다.

🔗 **[freedom-ai-alpha.vercel.app](https://freedom-ai-alpha.vercel.app)**

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 무한 캔버스 | 핀치 줌·패닝으로 끝없이 펼쳐지는 작업 공간 |
| 펜 & 지우개 | 3가지 굵기, 5가지 색상 / 소프트 브러시 지우개 |
| 포스트잇 | 추가·이동·리사이즈·텍스트 편집 |
| 이미지 삽입 | Ctrl+V 붙여넣기 또는 드래그 & 드롭으로 이미지 추가·이동·리사이즈 |
| 선택 툴 | 드래그로 여러 항목 범위 선택 후 한 번에 이동 |
| 실시간 협업 | Pusher 기반 커서·획·포스트잇 실시간 동기화 |
| Google 로그인 | Google 계정으로 즉시 입장, 로그아웃 시 계정 초기화 |
| 프로젝트 사이드바 | 좌측 사이드바에서 프로젝트 전환·추가·삭제 (`×` 버튼으로 개별 삭제 + 확인 창) |
| 자유 이동 패널 | 상단 툴바·좌측 사이드바를 드래그로 자유롭게 이동, 위치 자동 저장 |
| 데이터 보존 | 프로젝트별 작업 내용 자동 저장 및 복원 (localStorage) |
| 공유 링크 | 버튼 한 번으로 URL 복사, 팀원 즉시 초대 |

---

## 기술 스택

| 분류 | 기술 |
|------|------|
| 배포 | Vercel (Serverless Functions) |
| 실시간 | Pusher Channels (Presence Channel + Client Events) |
| 저장소 | Vercel KV (Redis) + localStorage fallback |
| 인증 | Google Identity Services (GIS) OAuth 팝업 |
| 프론트엔드 | Vanilla JS, Canvas API |
| 백엔드 | Node.js Serverless (`/api/*.js`) |

---

## 프로젝트 구조

```
Freedom-AI/
├── api/
│   ├── action.js        # 캔버스 액션 처리 (획·지우개·포스트잇)
│   ├── ai-transform.js  # AI 이미지 변환 프록시 (HF_TOKEN 필요)
│   ├── join.js          # 방 입장 & 초기 상태 반환
│   └── pusher-auth.js   # Pusher Presence 채널 인증
├── app.html             # 캔버스 앱 (메인)
├── index.html           # 랜딩 페이지
├── server.js            # 로컬 개발용 서버
├── vercel.json          # Vercel 배포 설정
└── package.json
```

---

## 로컬 개발

### 1. 설치

```bash
npm install
```

### 2. 환경변수 설정

`.env` 파일 생성:

```env
PUSHER_APP_ID=your_app_id
PUSHER_KEY=your_key
PUSHER_SECRET=your_secret
PUSHER_CLUSTER=your_cluster

# 선택 (없으면 localStorage로만 저장)
KV_REST_API_URL=your_kv_url
KV_REST_API_TOKEN=your_kv_token
```

### 3. 서버 실행

```bash
npm start       # 일반 실행
npm run dev     # 파일 변경 감지 자동 재시작
```

---

## Vercel 배포

### 필수 환경변수

| 변수명 | 설명 |
|--------|------|
| `PUSHER_APP_ID` | Pusher 앱 ID |
| `PUSHER_KEY` | Pusher 키 |
| `PUSHER_SECRET` | Pusher 시크릿 |
| `PUSHER_CLUSTER` | Pusher 클러스터 (예: `ap3`) |
| `KV_REST_API_URL` | Vercel KV URL (선택) |
| `KV_REST_API_TOKEN` | Vercel KV 토큰 (선택) |

### Pusher 설정

- Pusher 대시보드 **App Settings → Enable client events** 활성화 필수

### Google OAuth 설정

Google Cloud Console → 사용자 인증 정보 → **Authorized JavaScript origins** 에 배포 URL 추가:

```
https://your-domain.vercel.app
```

---

## 단축키

| 키 | 기능 |
|----|------|
| `P` | 펜 도구 |
| `E` | 지우개 |
| `S` | 포스트잇 |
| `H` | 이동(핸드) 도구 |
| `V` | 선택 툴 |
| `Ctrl + Z` | 실행 취소 |
| `+` / `-` | 줌 인/아웃 |
| `0` | 화면 초기화 |

---

## 주요 정책

- 룸당 최대 스트로크 1,000개
- 포스트잇 텍스트 최대 10,000자 / 크기 100px ~ 3,000px
- 이미지: 붙여넣기·드롭 시 최대 1,200px로 자동 압축 (JPEG 82%)
- 지우개: 클라이언트에서 직접 계산 후 결과 전송 (KV 없이도 동작)
- 포스트잇 삭제: 생성자 본인만 가능
- 데이터: Vercel KV 미설정 시 localStorage에 프로젝트별 자동 저장
- 패널 위치(툴바·사이드바): localStorage에 저장되어 새로고침 후에도 유지

---

## 로드맵

### 완료 ✅

- 무한 캔버스, 펜·소프트 지우개, 포스트잇
- 이미지 삽입 (붙여넣기·드래그 드롭·이동·리사이즈·삭제)
- 선택 툴 (범위 드래그 → 다중 항목 일괄 이동)
- Pusher 실시간 협업 (커서·획·포스트잇 동기화)
- Google 로그인 / 로그아웃 (매번 계정 선택 강제)
- 프로젝트 사이드바 (전환·추가·삭제·데이터 보존)
- 상단 툴바·좌측 사이드바 자유 이동 (위치 저장)
- Vercel 서버리스 배포

### 예정 🔜

- 기본 도형 도구 (사각형, 원, 화살표)
- 모바일 터치 최적화
- AI 이미지 생성·편집 / AI 아이디어 제안

---

© 2025 Freedom AI
