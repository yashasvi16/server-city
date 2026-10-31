package runs

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTest() (*Issuer, *clock) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	i := New("test-secret", time.Hour)
	i.now = c.now
	return i, c
}

func TestRoundTrip(t *testing.T) {
	i, c := newTest()
	tok, _ := i.Issue("defense")
	c.t = c.t.Add(2 * time.Minute)
	if err := i.Redeem(tok, "defense", 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := i.Redeem(tok, "defense", 90*time.Second); err != ErrUsed {
		t.Fatalf("second use: %v", err)
	}
}

func TestRejections(t *testing.T) {
	i, c := newTest()
	tok, _ := i.Issue("defense")
	c.t = c.t.Add(time.Minute)

	if err := i.Redeem(tok, "other", time.Second); err != ErrInvalid {
		t.Errorf("wrong board: %v", err)
	}
	if err := i.Redeem(tok, "defense", 5*time.Minute); err != ErrTooLong {
		t.Errorf("claimed longer than real elapsed time: %v", err)
	}
	// Tamper with the payload (flip a char) -> bad signature.
	p, s, _ := strings.Cut(tok, ".")
	bad := []byte(p)
	bad[3] ^= 1
	if err := i.Redeem(string(bad)+"."+s, "defense", time.Second); err != ErrInvalid {
		t.Errorf("tampered: %v", err)
	}
	for _, junk := range []string{"", "abc", "a.b", strings.Repeat("x", 300)} {
		if err := i.Redeem(junk, "defense", 0); err != ErrInvalid {
			t.Errorf("junk %q: %v", junk, err)
		}
	}
	// Different secret can't forge.
	other := New("another-secret", time.Hour)
	other.now = c.now
	forged, _ := other.Issue("defense")
	if err := i.Redeem(forged, "defense", 0); err != ErrInvalid {
		t.Errorf("forged: %v", err)
	}
	c.t = c.t.Add(2 * time.Hour)
	if err := i.Redeem(tok, "defense", time.Second); err != ErrExpired {
		t.Errorf("expired: %v", err)
	}
}

func TestConcurrentRedeemOnlyOnce(t *testing.T) {
	i := New("", time.Hour)
	tok, _ := i.Issue("b")
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i.Redeem(tok, "b", 0) == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ok != 1 {
		t.Fatalf("token redeemed %d times", ok)
	}
}
