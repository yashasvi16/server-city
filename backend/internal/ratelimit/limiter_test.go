package ratelimit

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) adv(d time.Duration) { c.t = c.t.Add(d) }
func newTest(rate float64, burst, max int) (*Limiter, *clock) {
	c := &clock{t: time.Unix(1000, 0)}
	l := New(rate, burst, time.Minute, max)
	l.now = c.now
	return l, c
}

func TestBurstThenRefill(t *testing.T) {
	l, c := newTest(2, 3, 100)
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d denied within burst", i)
		}
	}
	ok, retry := l.Allow("a")
	if ok {
		t.Fatal("4th request should be denied")
	}
	if retry != 500*time.Millisecond {
		t.Fatalf("retryAfter = %v, want 500ms", retry)
	}
	c.adv(500 * time.Millisecond)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("token should have refilled")
	}
	// Other keys are independent.
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("key b should have its own bucket")
	}
}

func TestRefillCapsAtBurst(t *testing.T) {
	l, c := newTest(10, 2, 100)
	l.Allow("a")
	c.adv(time.Hour)
	allowed := 0
	for i := 0; i < 5; i++ {
		if ok, _ := l.Allow("a"); ok {
			allowed++
		}
	}
	if allowed != 2 {
		t.Fatalf("allowed %d after long idle, want burst=2", allowed)
	}
}

func TestMaxKeysFailsClosedAndSweeps(t *testing.T) {
	l, c := newTest(1, 1, 3)
	for i := 0; i < 3; i++ {
		l.Allow(fmt.Sprint(i))
	}
	if ok, _ := l.Allow("new"); ok {
		t.Fatal("should fail closed when map is full of fresh keys")
	}
	c.adv(2 * time.Minute) // all idle past TTL
	if ok, _ := l.Allow("new"); !ok {
		t.Fatal("idle keys should be swept to make room")
	}
	if l.Len() != 1 {
		t.Fatalf("len = %d, want 1", l.Len())
	}
}

func TestConcurrentAllow(t *testing.T) {
	l := New(1000, 50, time.Minute, 1000)
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				if ok, _ := l.Allow("shared"); ok {
					mu.Lock()
					allowed++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	if allowed < 50 || allowed > 800 {
		t.Fatalf("allowed=%d out of plausible range", allowed)
	}
}

func TestBucket(t *testing.T) {
	b := NewBucket(1, 2)
	now := b.last
	if !b.AllowAt(now) || !b.AllowAt(now) || b.AllowAt(now) {
		t.Fatal("expected exactly burst=2 immediate tokens")
	}
	if !b.AllowAt(now.Add(time.Second)) {
		t.Fatal("expected refill after 1s")
	}
}
