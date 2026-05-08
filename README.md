# GhostTerm

Web-based multi-terminal server with persistent sessions. Self-hostable via Docker.

基于 Web 的多终端服务器，支持持久会话。可通过 Docker 自托管。

웹 기반 멀티 터미널 서버. 영구 세션을 지원하며 Docker로 셀프 호스팅 가능.

---

## Features / 功能 / 기능

**Workspaces & Tabs / 工作区与标签页 / 워크스페이스와 탭**

Organize terminals into workspaces. Each workspace holds multiple tabs. Workspaces persist until manually deleted.

将终端组织到工作区中。每个工作区包含多个标签页。工作区在手动删除前一直保留。

터미널을 워크스페이스로 그룹화합니다. 각 워크스페이스에 여러 탭을 생성할 수 있으며, 수동 삭제 전까지 유지됩니다.

**Persistent Sessions (tmux) / 持久会话 (tmux) / 영구 세션 (tmux)**

Close the browser — your processes keep running. Reconnect anytime and resume where you left off, including full scrollback. Powered by tmux: sessions survive both browser disconnects and server restarts.

关闭浏览器 — 进程继续运行。随时重新连接，包括完整的滚动历史记录。基于 tmux：会话在浏览器断开和服务器重启后均可存活。

브라우저를 닫아도 프로세스가 계속 실행됩니다. 재접속하면 스크롤백을 포함하여 이전 상태 그대로 복원됩니다. tmux 기반이므로 브라우저 종료는 물론 서버 재시작 후에도 세션이 유지됩니다.

**Single Binary / 单文件二进制 / 단일 바이너리**

~10MB Go binary with the React frontend embedded. No external dependencies except tmux.

约 10MB 的 Go 二进制文件，内嵌 React 前端。除 tmux 外无其他外部依赖。

React 프론트엔드가 내장된 ~10MB Go 바이너리. tmux 외에 외부 의존성이 없습니다.

**Password Authentication / 密码认证 / 비밀번호 인증**

bcrypt-hashed password with session cookies. On first launch, set a password to protect your terminal.

bcrypt 哈希密码与会话 Cookie。首次启动时设置密码以保护终端。

bcrypt 해시 비밀번호와 세션 쿠키. 첫 실행 시 비밀번호를 설정하여 터미널을 보호합니다.

---

## Quick Start / 快速开始 / 빠른 시작

### Docker

```bash
docker compose up -d
# Open http://localhost:8080
```

### Build from source / 从源码构建 / 소스에서 빌드

**Prerequisites / 前置条件 / 사전 요구사항:** Go 1.22+, Node.js 20+, tmux

```bash
git clone https://github.com/younkyum/loci-terminal.git
cd loci-terminal
make build
./ghostterm --port 8080
```

### Options / 选项 / 옵션

```
--port       Server port (default: 8080)
             服务器端口（默认：8080）
             서버 포트 (기본: 8080)

--data-dir   SQLite database directory (default: ./data)
             SQLite 数据库目录（默认：./data）
             SQLite 데이터베이스 디렉토리 (기본: ./data)
```

---

## Architecture / 架构 / 아키텍처

```
Browser                            Go Server (single binary)
┌─────────────────────┐           ┌──────────────────────────────────┐
│ React + xterm.js    │           │ net/http ServeMux                │
│                     │           │                                  │
│ Sidebar ──REST──────────────────> /api/v1/workspaces               │
│ TabBar  ──REST──────────────────> /api/v1/sessions                 │
│ xterm.js ═══WS══════════════════> /api/v1/ws/terminal/:id          │
│  binary frames (I/O) │          │   ├── tmux.Manager               │
│  JSON (control)      │          │   │   └── tmux sessions (persist)│
│                      │          │   └── store (SQLite)             │
└──────────────────────┘          └──────────────────────────────────┘
```

### Tech Stack / 技术栈 / 기술 스택

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, xterm.js, Zustand, Vite |
| Backend | Go (stdlib net/http), gorilla/websocket, creack/pty |
| Persistence | tmux (sessions), SQLite via modernc.org/sqlite (metadata) |
| Auth | bcrypt + session cookie |
| Deploy | Docker multi-stage build |

### How tmux Persistence Works / tmux 持久化原理 / tmux 영속성 동작 방식

```
1. Tab created    → tmux new-session -d -s gt_{id}
2. Browser opens  → creack/pty spawns "tmux attach -t gt_{id}"
                    PTY fd is bridged to WebSocket (binary frames)
3. Browser closes → PTY (attach process) terminates
                    tmux session keeps running in background
4. Reconnect      → new "tmux attach" → scrollback + processes restored
5. Tab deleted    → tmux kill-session -t gt_{id}
```

The tmux server runs independently from the Go process. Even if the Go server crashes or restarts, tmux sessions survive.

tmux 服务器独立于 Go 进程运行。即使 Go 服务器崩溃或重启，tmux 会话也不会丢失。

tmux 서버는 Go 프로세스와 독립적으로 동작합니다. Go 서버가 크래시하거나 재시작해도 tmux 세션은 유지됩니다.

### WebSocket Protocol / WebSocket 协议 / WebSocket 프로토콜

Two frame types on the same connection:

| Direction | Type | Content |
|-----------|------|---------|
| Client → Server | Binary | Terminal stdin (keystrokes) |
| Server → Client | Binary | Terminal stdout (output) |
| Client → Server | Text (JSON) | `{ type: "resize", cols, rows }` |
| Server → Client | Text (JSON) | `{ type: "attached" }`, `{ type: "pong" }` |

Binary frames carry raw terminal I/O with zero encoding overhead.

二进制帧传输原始终端 I/O，零编码开销。

Binary 프레임은 인코딩 오버헤드 없이 터미널 I/O를 직접 전달합니다.

### REST API

```
POST   /api/v1/auth/setup            # First-run password setup
POST   /api/v1/auth/login            # Login
POST   /api/v1/auth/logout           # Logout
GET    /api/v1/auth/check            # Check auth state

GET    /api/v1/workspaces            # List workspaces
POST   /api/v1/workspaces            # Create workspace
PATCH  /api/v1/workspaces/:id        # Rename workspace
DELETE /api/v1/workspaces/:id        # Delete workspace (cascades sessions)

GET    /api/v1/workspaces/:wid/sessions   # List sessions
POST   /api/v1/workspaces/:wid/sessions   # Create session
PATCH  /api/v1/sessions/:id               # Rename session
DELETE /api/v1/sessions/:id               # Delete session

GET    /api/v1/ws/terminal/:sessionId     # WebSocket terminal
```

---

## Project Structure / 项目结构 / 프로젝트 구조

```
ghostterm/
├── cmd/ghostterm/main.go              # Entrypoint, embed.FS, graceful shutdown
├── internal/
│   ├── server/
│   │   ├── server.go                  # HTTP routing, auth middleware
│   │   └── auth.go                    # Session cookie management
│   ├── api/
│   │   ├── workspace.go               # Workspace CRUD handlers
│   │   ├── session.go                 # Session CRUD handlers
│   │   ├── auth.go                    # Login/setup/logout handlers
│   │   └── helpers.go                 # JSON response helpers
│   ├── ws/
│   │   ├── handler.go                 # WebSocket upgrade + PTY bridge
│   │   └── protocol.go               # Control message types
│   ├── tmux/
│   │   ├── manager.go                 # tmux session lifecycle
│   │   └── session.go                 # PTY wrapper for tmux attach
│   ├── store/
│   │   ├── store.go                   # Store interface
│   │   └── sqlite.go                  # SQLite implementation + migrations
│   └── model/model.go                 # Workspace, Session structs
├── frontend/
│   └── src/
│       ├── App.tsx                    # Auth gate + layout
│       ├── components/
│       │   ├── Auth/LoginForm.tsx     # Login / setup form
│       │   ├── Sidebar/Sidebar.tsx    # Workspace list
│       │   └── Terminal/
│       │       ├── TabBar.tsx         # Session tab strip
│       │       ├── TerminalPanel.tsx  # Tab bar + terminal viewport
│       │       └── TerminalView.tsx   # xterm.js instance
│       ├── hooks/useTerminal.ts       # xterm.js + WebSocket lifecycle
│       ├── stores/appStore.ts         # Zustand state management
│       ├── api/client.ts              # REST API client
│       └── lib/theme.ts              # Ghostty-inspired dark theme
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

---

## Development / 开发 / 개발

```bash
# Run tests (Go + Frontend)
# 运行测试（Go + 前端）
# 테스트 실행 (Go + 프론트엔드)
make test

# Go tests only / 仅 Go 测试 / Go 테스트만
make test-go

# Frontend tests only / 仅前端测试 / 프론트엔드 테스트만
make test-frontend

# Dev mode (two terminals)
# 开发模式（两个终端）
# 개발 모드 (터미널 두 개)
make dev-backend     # Terminal 1: Go server on :8080
make dev-frontend    # Terminal 2: Vite dev server with proxy
```

---

## Design Decisions / 设计决策 / 설계 결정

| Decision / 决策 / 결정 | Rationale / 理由 / 이유 |
|---|---|
| **Go stdlib net/http** | ~12 endpoints. Go 1.22+ ServeMux handles method routing natively. No framework needed. / 约12个端点，Go 1.22+ 原生支持方法路由。/ 12개 수준의 API, Go 1.22+ ServeMux로 충분. |
| **modernc.org/sqlite** | Pure Go, no CGo. Enables static binary and cross-compilation. / 纯 Go 实现，无需 CGo，支持静态编译。/ 순수 Go 구현, CGo 불필요, 정적 바이너리 가능. |
| **tmux for persistence** | Sessions survive browser close AND server restart. Independent process. / 会话在浏览器关闭和服务器重启后存活。/ 브라우저 종료 + 서버 재시작에도 세션 생존. |
| **Binary WebSocket frames** | Zero encoding overhead vs Base64 JSON. Critical for high-throughput terminal output. / 零编码开销，高吞吐量终端输出必需。/ Base64 대비 33% 오버헤드 절감. |
| **Session cookie (not JWT)** | Simpler and revocable for single-user self-hosting. / 单用户自托管场景更简单可靠。/ 싱글유저 셀프호스팅에 더 간단하고 안전. |
| **Zustand** | Minimal state management. No Redux boilerplate. / 极简状态管理，无冗余代码。/ 최소한의 상태 관리, 보일러플레이트 없음. |

---

## Roadmap / 路线图 / 로드맵

- [ ] Code Review panel (git diff viewer) / 代码审查面板 / 코드 리뷰 패널
- [ ] Multi-user support / 多用户支持 / 멀티유저 지원
- [ ] Tab drag-to-reorder / 标签页拖拽排序 / 탭 드래그 정렬
- [ ] Terminal search / 终端搜索 / 터미널 검색
- [ ] Custom themes / 自定义主题 / 커스텀 테마
- [ ] HTTPS/TLS support / HTTPS/TLS 支持 / HTTPS/TLS 지원

---

## License

MIT
