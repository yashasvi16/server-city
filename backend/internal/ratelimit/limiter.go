// Package ratelimit implements a keyed token-bucket limiter with bounded
// memory, suitable for per-IP limits on a small public server.
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter allows `burst` requests instantly and refills at `rate` per second,
// independently for each key.
type Limiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	idleTTL time.Duration
	maxKeys int
	now     func() time.Time
	buckets map[string]*bucket
}

// New creates a limiter. maxKeys bounds memory: when the map is full, idle
// buckets are swept, and if it is still full the request is denied (fail
// closed) rather than letting an attacker grow the map without limit.
func New(rate float64, burst int, idleTTL time.Duration, maxKeys int) *Limiter {
	return &Limiter{
		rate: rate, burst: float64(burst), idleTTL: idleTTL, maxKeys: maxKeys,
		now: time.Now, buckets: make(map[string]*bucket),
	}
}

// Allow reports whether one event for key may happen now. When it returns
// false, retryAfter estimates when the next token becomes available.
func (l *Limiter) Allow(key string) (ok bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, found := l.buckets[key]
	if !found {
		if len(l.buckets) >= l.maxKeys {
			l.sweepLocked(now)
			if len(l.buckets) >= l.maxKeys {
				return false, time.Second
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	need := (1 - b.tokens) / l.rate
	return false, time.Duration(need * float64(time.Second))
}

func (l *Limiter) sweepLocked(now time.Time) {
	for k, b := range l.buckets {
		if now.Sub(b.last) > l.idleTTL {
			delete(l.buckets, k)
		}
	}
}

// Sweep removes idle buckets. Call periodically.
func (l *Limiter) Sweep() {
	l.mu.Lock()
	l.sweepLocked(l.now())
	l.mu.Unlock()
}

// Len returns the number of tracked keys.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Bucket is a single unkeyed token bucket (not safe for concurrent use);
// used for per-connection message limits where one goroutine owns it.
type Bucket struct {
	rate, burst, tokens float64
	last                time.Time
}

// NewBucket returns a full bucket.
func NewBucket(rate float64, burst int) *Bucket {
	return &Bucket{rate: rate, burst: float64(burst), tokens: float64(burst), last: time.Now()}
}

// AllowAt consumes a token if one is available at time now.
func (b *Bucket) AllowAt(now time.Time) bool {
	if el := now.Sub(b.last).Seconds(); el > 0 {
		b.tokens = min(b.burst, b.tokens+el*b.rate)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}
