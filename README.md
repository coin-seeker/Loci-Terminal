# Loci Terminal

[한국어](README.ko.md) | [中文](README.zh-CN.md) | **English**

Web-based multi-terminal server with persistent sessions. Self-hostable via Docker.

## Features

- **Workspaces & Tabs** — Organize terminals into persistent workspace groups. Each workspace holds multiple tabs.
- **Persistent Sessions (tmux)** — Close the browser, your processes keep running. Reconnect anytime with full scrollback restored. Sessions survive both browser disconnects and server restarts.
- **Single Binary** — ~10MB Go binary with React frontend embedded. No external dependencies except tmux.
- **Password Authentication** — bcrypt-hashed password with session cookies. Set a password on first launch to protect your terminal.

## Quick Start

### Docker

```bash
docker compose up -d
# Open http://localhost:8080
```

### Build from source

**Prerequisites:** Go 1.22+, Node.js 20+, tmux

```bash
git clone https://github.com/Younkyum/Loci-Terminal.git
cd Loci-Terminal
make build
./ghostterm --port 8080
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--port` | Server port | `8080` |
| `--data-dir` | SQLite database directory | `./data` |

## Architecture

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

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, xterm.js, Zustand, Vite |
| Backend | Go (stdlib net/http), gorilla/websocket, creack/pty |
| Persistence | tmux (sessions), SQLite via modernc.org/sqlite (metadata) |
| Auth | bcrypt + session cookie |
| Deploy | Docker multi-stage build |

### How tmux Persistence Works

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

### WebSocket Protocol

Two frame types on the same connection:

| Direction | Type | Content |
|-----------|------|---------|
| Client → Server | Binary | Terminal stdin (keystrokes) |
| Server → Client | Binary | Terminal stdout (output) |
| Client → Server | Text (JSON) | `{ type: "resize", cols, rows }` |
| Server → Client | Text (JSON) | `{ type: "attached" }`, `{ type: "pong" }` |

Binary frames carry raw terminal I/O with zero encoding overhead.

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

## Project Structure

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

## Development

```bash
make test              # Run all tests (Go + Frontend)
make test-go           # Go tests only
make test-frontend     # Frontend tests only

# Dev mode (two terminals)
make dev-backend       # Terminal 1: Go server on :8080
make dev-frontend      # Terminal 2: Vite dev server with proxy
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Go stdlib net/http** | ~12 endpoints. Go 1.22+ ServeMux handles method routing natively. No framework needed. |
| **modernc.org/sqlite** | Pure Go, no CGo. Enables static binary and cross-compilation. |
| **tmux for persistence** | Sessions survive browser close AND server restart. Independent process. |
| **Binary WebSocket frames** | Zero encoding overhead vs Base64 JSON. Critical for high-throughput terminal output. |
| **Session cookie (not JWT)** | Simpler and revocable for single-user self-hosting. |
| **Zustand** | Minimal state management. No Redux boilerplate. |

## Roadmap

- [ ] Code Review panel (git diff viewer)
- [ ] Multi-user support
- [ ] Tab drag-to-reorder
- [ ] Terminal search
- [ ] Custom themes
- [ ] HTTPS/TLS support

## License

MIT
