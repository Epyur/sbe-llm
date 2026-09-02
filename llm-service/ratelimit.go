package main

import (
	"sync"
	"time"
)

// emailLimiter — fixed-window rate limiter в памяти, ключ — email пользователя
// (не IP): расход у провайдера привязан к пользователю независимо от того, с
// какого устройства/сети он обращается (плагин на одном компьютере, веб-портал
// на другом). Один инстанс — llm-service не масштабируется горизонтально.
type emailLimiter struct {
	mu   sync.Mutex
	win  time.Duration
	max  int
	seen map[string]*emailWindow
}

type emailWindow struct {
	start time.Time
	count int
}

func newEmailLimiter(win time.Duration, max int) *emailLimiter {
	return &emailLimiter{win: win, max: max, seen: make(map[string]*emailWindow)}
}

func (l *emailLimiter) allow(email string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.seen[email]
	if !ok || now.Sub(w.start) >= l.win {
		l.seen[email] = &emailWindow{start: now, count: 1}
		return true
	}
	w.count++
	if len(l.seen) > 10000 {
		for k, v := range l.seen {
			if now.Sub(v.start) >= l.win {
				delete(l.seen, k)
			}
		}
	}
	return w.count <= l.max
}
