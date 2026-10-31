package metrics

import (
	"sync"
	"testing"
	"time"
)

func TestPercentileNearestRank(t *testing.T) {
	var s []time.Duration
	for i := 1; i <= 100; i++ {
		s = append(s, time.Duration(i)*time.Millisecond)
	}
	cases := map[float64]time.Duration{0.5: 50 * time.Millisecond, 0.95: 95 * time.Millisecond, 0.99: 99 * time.Millisecond, 1: 100 * time.Millisecond}
	for p, want := range cases {
		if got := Percentile(s, p); got != want {
			t.Errorf("p%.0f = %v, want %v", p*100, got, want)
		}
	}
	if Percentile(nil, 0.95) != 0 {
		t.Error("empty should be 0")
	}
}

func TestRingWindowEvictsOld(t *testing.T) {
	r := New(10)
	for i := 0; i < 10; i++ {
		r.Observe(time.Second, 200) // old slow samples
	}
	for i := 0; i < 10; i++ {
		r.Observe(time.Millisecond, 200)
	}
	s := r.Snapshot()
	if s.P95Ms != 1 || s.WindowSamples != 10 || s.RequestsServed != 20 {
		t.Fatalf("snapshot = %+v", s)
	}
}

func TestErrorsCounted(t *testing.T) {
	r := New(4)
	r.Observe(time.Millisecond, 500)
	r.Observe(time.Millisecond, 404)
	if r.Snapshot().Errors5xx != 1 {
		t.Fatal("expected one 5xx")
	}
}

func TestConcurrentObserve(t *testing.T) {
	r := New(256)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				r.Observe(time.Duration(i)*time.Microsecond, 200)
				if i%50 == 0 {
					_ = r.Snapshot()
				}
			}
		}()
	}
	wg.Wait()
	if got := r.Snapshot().RequestsServed; got != 4000 {
		t.Fatalf("total = %d", got)
	}
}
