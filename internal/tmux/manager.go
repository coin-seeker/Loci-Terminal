package tmux

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
)

const sessionPrefix = "gt_"

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	shell    string
}

func NewManager() *Manager {
	shell := detectShell()
	return &Manager{
		sessions: make(map[string]*Session),
		shell:    shell,
	}
}

func (m *Manager) CreateSession(sessionID string, cols, rows uint16) error {
	name := sessionPrefix + sessionID

	home, _ := os.UserHomeDir()
	cmd := exec.Command("tmux", "new-session", "-d", "-s", name,
		"-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows),
		"-c", home,
		m.shell)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %w: %s", err, string(out))
	}
	return nil
}

func (m *Manager) Attach(sessionID string, cols, rows uint16) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	name := sessionPrefix + sessionID

	if !m.tmuxSessionExists(name) {
		cmd := exec.Command("tmux", "new-session", "-d", "-s", name,
			"-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows),
			m.shell)
		if out, err := cmd.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("tmux new-session: %w: %s", err, string(out))
		}
	}

	sess, err := newSession(name, cols, rows)
	if err != nil {
		return nil, err
	}
	m.sessions[sessionID] = sess
	return sess, nil
}

func (m *Manager) Detach(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if sess, ok := m.sessions[sessionID]; ok {
		sess.Close()
		delete(m.sessions, sessionID)
	}
}

func (m *Manager) Resize(sessionID string, cols, rows uint16) error {
	name := sessionPrefix + sessionID

	cmd := exec.Command("tmux", "resize-window", "-t", name,
		"-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux resize: %w: %s", err, string(out))
	}
	return nil
}

func (m *Manager) KillSession(sessionID string) error {
	m.Detach(sessionID)

	name := sessionPrefix + sessionID
	cmd := exec.Command("tmux", "kill-session", "-t", name)
	cmd.Run()
	return nil
}

func (m *Manager) ListTmuxSessions() ([]string, error) {
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}")
	out, err := cmd.Output()
	if err != nil {
		if strings.Contains(err.Error(), "no server running") ||
			strings.Contains(string(out), "no server running") {
			return nil, nil
		}
		return nil, nil
	}

	var sessions []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, sessionPrefix) {
			id := strings.TrimPrefix(line, sessionPrefix)
			sessions = append(sessions, id)
		}
	}
	return sessions, nil
}

func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, sess := range m.sessions {
		sess.Close()
		delete(m.sessions, id)
	}
}

func (m *Manager) tmuxSessionExists(name string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", name)
	return cmd.Run() == nil
}

func detectShell() string {
	for _, sh := range []string{"/bin/zsh", "/bin/bash", "/bin/sh"} {
		if _, err := exec.LookPath(sh); err == nil {
			return sh
		}
	}
	return "/bin/sh"
}
