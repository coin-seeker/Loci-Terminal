# Loci Terminal

[English](README.md) | [中文](README.zh-CN.md) | **한국어**

웹 기반 멀티 터미널 서버. 영구 세션을 지원하며 Docker로 셀프 호스팅 가능합니다.

## 주요 기능

- **워크스페이스와 탭** — 터미널을 워크스페이스로 그룹화합니다. 각 워크스페이스에 여러 탭을 생성할 수 있으며, 수동 삭제 전까지 유지됩니다.
- **영구 세션 (tmux)** — 브라우저를 닫아도 프로세스가 계속 실행됩니다. 재접속하면 스크롤백을 포함하여 이전 상태 그대로 복원됩니다. 브라우저 종료는 물론 서버 재시작 후에도 세션이 유지됩니다.
- **단일 바이너리** — React 프론트엔드가 내장된 ~10MB Go 바이너리. tmux 외에 외부 의존성이 없습니다.
- **비밀번호 인증** — bcrypt 해시 비밀번호와 세션 쿠키. 첫 실행 시 비밀번호를 설정하여 터미널을 보호합니다.

## 빠른 시작

### Docker

```bash
docker compose up -d
# http://localhost:8080 접속
```

### 소스에서 빌드

**사전 요구사항:** Go 1.22+, Node.js 20+, tmux

```bash
git clone https://github.com/Younkyum/Loci-Terminal.git
cd Loci-Terminal
make build
./ghostterm --port 8080
```

### 옵션

| 플래그 | 설명 | 기본값 |
|--------|------|--------|
| `--port` | 서버 포트 | `8080` |
| `--data-dir` | SQLite 데이터베이스 디렉토리 | `./data` |

## 아키텍처

```
브라우저                             Go 서버 (단일 바이너리)
┌─────────────────────┐           ┌──────────────────────────────────┐
│ React + xterm.js    │           │ net/http ServeMux                │
│                     │           │                                  │
│ 사이드바 ──REST─────────────────> /api/v1/workspaces               │
│ 탭바    ──REST─────────────────> /api/v1/sessions                  │
│ xterm.js ═══WS═════════════════> /api/v1/ws/terminal/:id           │
│  binary 프레임 (I/O)  │         │   ├── tmux.Manager               │
│  JSON (제어)          │         │   │   └── tmux 세션 (영구)        │
│                      │          │   └── store (SQLite)             │
└──────────────────────┘          └──────────────────────────────────┘
```

### 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | React 19, TypeScript, xterm.js, Zustand, Vite |
| 백엔드 | Go (stdlib net/http), gorilla/websocket, creack/pty |
| 영속성 | tmux (세션), SQLite via modernc.org/sqlite (메타데이터) |
| 인증 | bcrypt + 세션 쿠키 |
| 배포 | Docker 멀티 스테이지 빌드 |

### tmux 영속성 동작 방식

```
1. 탭 생성     → tmux new-session -d -s gt_{id}
2. 브라우저 접속 → creack/pty가 "tmux attach -t gt_{id}" 실행
                  PTY fd를 WebSocket에 브릿지 (binary 프레임)
3. 브라우저 종료 → PTY (attach 프로세스)만 종료
                  tmux 세션은 백그라운드에서 계속 실행
4. 재접속       → 새로운 "tmux attach" → 스크롤백 + 프로세스 복원
5. 탭 삭제     → tmux kill-session -t gt_{id}
```

tmux 서버는 Go 프로세스와 독립적으로 동작합니다. Go 서버가 크래시하거나 재시작해도 tmux 세션은 유지됩니다.

### WebSocket 프로토콜

하나의 연결에서 두 종류의 프레임을 사용합니다:

| 방향 | 타입 | 내용 |
|------|------|------|
| 클라이언트 → 서버 | Binary | 터미널 stdin (키 입력) |
| 서버 → 클라이언트 | Binary | 터미널 stdout (출력) |
| 클라이언트 → 서버 | Text (JSON) | `{ type: "resize", cols, rows }` |
| 서버 → 클라이언트 | Text (JSON) | `{ type: "attached" }`, `{ type: "pong" }` |

Binary 프레임은 인코딩 오버헤드 없이 터미널 I/O를 직접 전달합니다.

### REST API

```
POST   /api/v1/auth/setup            # 초기 비밀번호 설정
POST   /api/v1/auth/login            # 로그인
POST   /api/v1/auth/logout           # 로그아웃
GET    /api/v1/auth/check            # 인증 상태 확인

GET    /api/v1/workspaces            # 워크스페이스 목록
POST   /api/v1/workspaces            # 워크스페이스 생성
PATCH  /api/v1/workspaces/:id        # 워크스페이스 이름 변경
DELETE /api/v1/workspaces/:id        # 워크스페이스 삭제 (세션 함께 삭제)

GET    /api/v1/workspaces/:wid/sessions   # 세션 목록
POST   /api/v1/workspaces/:wid/sessions   # 세션 생성
PATCH  /api/v1/sessions/:id               # 세션 이름 변경
DELETE /api/v1/sessions/:id               # 세션 삭제

GET    /api/v1/ws/terminal/:sessionId     # WebSocket 터미널
```

## 프로젝트 구조

```
ghostterm/
├── cmd/ghostterm/main.go              # 진입점, embed.FS, graceful shutdown
├── internal/
│   ├── server/
│   │   ├── server.go                  # HTTP 라우팅, 인증 미들웨어
│   │   └── auth.go                    # 세션 쿠키 관리
│   ├── api/
│   │   ├── workspace.go               # 워크스페이스 CRUD 핸들러
│   │   ├── session.go                 # 세션 CRUD 핸들러
│   │   ├── auth.go                    # 로그인/설정/로그아웃 핸들러
│   │   └── helpers.go                 # JSON 응답 헬퍼
│   ├── ws/
│   │   ├── handler.go                 # WebSocket 업그레이드 + PTY 브릿지
│   │   └── protocol.go               # 제어 메시지 타입
│   ├── tmux/
│   │   ├── manager.go                 # tmux 세션 라이프사이클
│   │   └── session.go                 # tmux attach용 PTY 래퍼
│   ├── store/
│   │   ├── store.go                   # Store 인터페이스
│   │   └── sqlite.go                  # SQLite 구현 + 마이그레이션
│   └── model/model.go                 # Workspace, Session 구조체
├── frontend/
│   └── src/
│       ├── App.tsx                    # 인증 게이트 + 레이아웃
│       ├── components/
│       │   ├── Auth/LoginForm.tsx     # 로그인/설정 폼
│       │   ├── Sidebar/Sidebar.tsx    # 워크스페이스 목록
│       │   └── Terminal/
│       │       ├── TabBar.tsx         # 세션 탭 스트립
│       │       ├── TerminalPanel.tsx  # 탭바 + 터미널 뷰포트
│       │       └── TerminalView.tsx   # xterm.js 인스턴스
│       ├── hooks/useTerminal.ts       # xterm.js + WebSocket 라이프사이클
│       ├── stores/appStore.ts         # Zustand 상태 관리
│       ├── api/client.ts              # REST API 클라이언트
│       └── lib/theme.ts              # Ghostty 스타일 다크 테마
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

## 개발

```bash
make test              # 전체 테스트 (Go + 프론트엔드)
make test-go           # Go 테스트만
make test-frontend     # 프론트엔드 테스트만

# 개발 모드 (터미널 두 개)
make dev-backend       # 터미널 1: Go 서버 (:8080)
make dev-frontend      # 터미널 2: Vite 개발 서버 (프록시)
```

## 설계 결정

| 결정 | 이유 |
|------|------|
| **Go stdlib net/http** | 12개 수준의 API. Go 1.22+ ServeMux가 메서드 라우팅을 기본 지원. 프레임워크 불필요. |
| **modernc.org/sqlite** | 순수 Go 구현, CGo 불필요. 정적 바이너리 및 크로스 컴파일 가능. |
| **tmux 기반 영속성** | 브라우저 종료 + 서버 재시작에도 세션 생존. 독립 프로세스. |
| **Binary WebSocket 프레임** | Base64 JSON 대비 인코딩 오버헤드 제로. 고출력 터미널에 필수. |
| **세션 쿠키 (JWT 아님)** | 싱글유저 셀프호스팅에 더 간단하고 취소 가능. |
| **Zustand** | 최소한의 상태 관리. Redux 보일러플레이트 없음. |

## 로드맵

- [ ] 코드 리뷰 패널 (git diff 뷰어)
- [ ] 멀티유저 지원
- [ ] 탭 드래그 정렬
- [ ] 터미널 검색
- [ ] 커스텀 테마
- [ ] HTTPS/TLS 지원

## 라이선스

MIT
