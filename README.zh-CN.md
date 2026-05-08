# Loci Terminal

[English](README.md) | **中文** | [한국어](README.ko.md)

基于 Web 的多终端服务器，支持持久会话。可通过 Docker 自托管。

## 功能特性

- **工作区与标签页** — 将终端组织到工作区中。每个工作区包含多个标签页。工作区在手动删除前一直保留。
- **持久会话 (tmux)** — 关闭浏览器，进程继续运行。随时重新连接，包括完整的滚动历史记录。会话在浏览器断开和服务器重启后均可存活。
- **单文件二进制** — 约 10MB 的 Go 二进制文件，内嵌 React 前端。除 tmux 外无其他外部依赖。
- **密码认证** — bcrypt 哈希密码与会话 Cookie。首次启动时设置密码以保护终端。

## 快速开始

### Docker

```bash
docker compose up -d
# 访问 http://localhost:8080
```

### 从源码构建

**前置条件：** Go 1.22+, Node.js 20+, tmux

```bash
git clone https://github.com/Younkyum/Loci-Terminal.git
cd Loci-Terminal
make build
./ghostterm --port 8080
```

### 配置选项

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | 服务器端口 | `8080` |
| `--data-dir` | SQLite 数据库目录 | `./data` |

## 架构

```
浏览器                              Go 服务器（单文件二进制）
┌─────────────────────┐           ┌──────────────────────────────────┐
│ React + xterm.js    │           │ net/http ServeMux                │
│                     │           │                                  │
│ 侧边栏 ──REST──────────────────> /api/v1/workspaces               │
│ 标签栏 ──REST──────────────────> /api/v1/sessions                  │
│ xterm.js ═══WS═════════════════> /api/v1/ws/terminal/:id           │
│  二进制帧（I/O）      │          │   ├── tmux.Manager               │
│  JSON（控制）         │          │   │   └── tmux 会话（持久）       │
│                      │          │   └── store（SQLite）             │
└──────────────────────┘          └──────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19, TypeScript, xterm.js, Zustand, Vite |
| 后端 | Go（stdlib net/http）, gorilla/websocket, creack/pty |
| 持久化 | tmux（会话）, SQLite via modernc.org/sqlite（元数据） |
| 认证 | bcrypt + 会话 Cookie |
| 部署 | Docker 多阶段构建 |

### tmux 持久化原理

```
1. 创建标签页  → tmux new-session -d -s gt_{id}
2. 浏览器连接  → creack/pty 启动 "tmux attach -t gt_{id}"
                PTY fd 桥接到 WebSocket（二进制帧）
3. 浏览器关闭  → PTY（attach 进程）终止
                tmux 会话在后台继续运行
4. 重新连接    → 新的 "tmux attach" → 滚动历史 + 进程恢复
5. 删除标签页  → tmux kill-session -t gt_{id}
```

tmux 服务器独立于 Go 进程运行。即使 Go 服务器崩溃或重启，tmux 会话也不会丢失。

### WebSocket 协议

同一连接上使用两种帧类型：

| 方向 | 类型 | 内容 |
|------|------|------|
| 客户端 → 服务器 | Binary | 终端 stdin（键盘输入） |
| 服务器 → 客户端 | Binary | 终端 stdout（输出） |
| 客户端 → 服务器 | Text（JSON） | `{ type: "resize", cols, rows }` |
| 服务器 → 客户端 | Text（JSON） | `{ type: "attached" }`, `{ type: "pong" }` |

二进制帧传输原始终端 I/O，零编码开销。

### REST API

```
POST   /api/v1/auth/setup            # 首次密码设置
POST   /api/v1/auth/login            # 登录
POST   /api/v1/auth/logout           # 登出
GET    /api/v1/auth/check            # 检查认证状态

GET    /api/v1/workspaces            # 列出工作区
POST   /api/v1/workspaces            # 创建工作区
PATCH  /api/v1/workspaces/:id        # 重命名工作区
DELETE /api/v1/workspaces/:id        # 删除工作区（级联删除会话）

GET    /api/v1/workspaces/:wid/sessions   # 列出会话
POST   /api/v1/workspaces/:wid/sessions   # 创建会话
PATCH  /api/v1/sessions/:id               # 重命名会话
DELETE /api/v1/sessions/:id               # 删除会话

GET    /api/v1/ws/terminal/:sessionId     # WebSocket 终端
```

## 项目结构

```
ghostterm/
├── cmd/ghostterm/main.go              # 入口点、embed.FS、优雅关闭
├── internal/
│   ├── server/
│   │   ├── server.go                  # HTTP 路由、认证中间件
│   │   └── auth.go                    # 会话 Cookie 管理
│   ├── api/
│   │   ├── workspace.go               # 工作区 CRUD 处理器
│   │   ├── session.go                 # 会话 CRUD 处理器
│   │   ├── auth.go                    # 登录/设置/登出处理器
│   │   └── helpers.go                 # JSON 响应辅助函数
│   ├── ws/
│   │   ├── handler.go                 # WebSocket 升级 + PTY 桥接
│   │   └── protocol.go               # 控制消息类型
│   ├── tmux/
│   │   ├── manager.go                 # tmux 会话生命周期
│   │   └── session.go                 # tmux attach 的 PTY 包装器
│   ├── store/
│   │   ├── store.go                   # Store 接口
│   │   └── sqlite.go                  # SQLite 实现 + 迁移
│   └── model/model.go                 # Workspace、Session 结构体
├── frontend/
│   └── src/
│       ├── App.tsx                    # 认证门控 + 布局
│       ├── components/
│       │   ├── Auth/LoginForm.tsx     # 登录/设置表单
│       │   ├── Sidebar/Sidebar.tsx    # 工作区列表
│       │   └── Terminal/
│       │       ├── TabBar.tsx         # 会话标签条
│       │       ├── TerminalPanel.tsx  # 标签栏 + 终端视口
│       │       └── TerminalView.tsx   # xterm.js 实例
│       ├── hooks/useTerminal.ts       # xterm.js + WebSocket 生命周期
│       ├── stores/appStore.ts         # Zustand 状态管理
│       ├── api/client.ts              # REST API 客户端
│       └── lib/theme.ts              # Ghostty 风格暗色主题
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

## 开发

```bash
make test              # 运行所有测试（Go + 前端）
make test-go           # 仅 Go 测试
make test-frontend     # 仅前端测试

# 开发模式（两个终端）
make dev-backend       # 终端 1：Go 服务器（:8080）
make dev-frontend      # 终端 2：Vite 开发服务器（代理）
```

## 设计决策

| 决策 | 理由 |
|------|------|
| **Go stdlib net/http** | 约 12 个端点。Go 1.22+ ServeMux 原生支持方法路由，无需框架。 |
| **modernc.org/sqlite** | 纯 Go 实现，无需 CGo。支持静态二进制和交叉编译。 |
| **tmux 持久化** | 会话在浏览器关闭和服务器重启后均存活。独立进程。 |
| **二进制 WebSocket 帧** | 相比 Base64 JSON 零编码开销。高吞吐量终端输出必需。 |
| **会话 Cookie（非 JWT）** | 单用户自托管场景更简单且可撤销。 |
| **Zustand** | 极简状态管理，无 Redux 冗余代码。 |

## 路线图

- [ ] 代码审查面板（git diff 查看器）
- [ ] 多用户支持
- [ ] 标签页拖拽排序
- [ ] 终端搜索
- [ ] 自定义主题
- [ ] HTTPS/TLS 支持

## 许可证

MIT
