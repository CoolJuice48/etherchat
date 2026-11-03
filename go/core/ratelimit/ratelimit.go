// Package ratelimit has an in-memory sliding-window limiter and the helper
// that finds a request's client address behind the Cloudflare tunnel.
package ratelimit

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// Window is a sliding-window rate limiter keyed by string. It lives in
// memory, which is enough for one etherd process.
type Window struct {
	mu   sync.Mutex
	hits map[string][]time.Time
	now  func() time.Time
}

// New returns a limiter using clock now (time.Now if nil).
func New(now func() time.Time) *Window {
	if now == nil {
		now = time.Now
	}
	return &Window{hits: map[string][]time.Time{}, now: now}
}

// Allow records a hit for key and reports whether it is within max hits per window.
func (l *Window) Allow(key string, max int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-window)
	if len(l.hits) > 10_000 {
		for k, h := range l.hits {
			if len(h) == 0 || h[len(h)-1].Before(cutoff) {
				delete(l.hits, k)
			}
		}
	}
	h := l.hits[key]
	i := 0
	for i < len(h) && !h[i].After(cutoff) {
		i++
	}
	h = h[i:]
	if len(h) >= max {
		l.hits[key] = h
		return false
	}
	l.hits[key] = append(h, now)
	return true
}

// ClientIP is the visitor's address: Cloudflare's CF-Connecting-IP for tunnel
// traffic, otherwise the connection's address. etherd listens only on
// loopback, so the header can only come from cloudflared or a local process.
func ClientIP(r *http.Request) string {
	if ip := r.Header.Get("Cf-Connecting-Ip"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
