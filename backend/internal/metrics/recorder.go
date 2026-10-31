// Package metrics records request counts and a sliding window of latencies
// so the site can report its own p50/p95/p99 on the city billboard.
package metrics

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Recorder keeps the last `window` latency samples in a ring buffer.
// Percentiles are exact over that window (sort a copy on read), which is
// cheap for a few thousand samples and avoids histogram bucket error.
type Recorder struct {
	started  time.Time
	total    atomic.Uint64
	errors5x atomic.Uint64

	mu   sync.Mutex
	ring []time.Duration
	next int
	full bool
}

// New creates a recorder with the given sample window size.
func New(window int) *Recorder {
	if window <= 0 {
		window = 2048
	}
	return &Recorder{started: time.Now(), ring: make([]time.Duration, window)}
}

// Count records a request without a latency sample (e.g. long-lived sockets).
func (r *Recorder) Count() { r.total.Add(1) }

// Observe records one completed request.
func (r *Recorder) Observe(d time.Duration, status int) {
	r.total.Add(1)
	if status >= 500 {
		r.errors5x.Add(1)
	}
	r.mu.Lock()
	r.ring[r.next] = d
	r.next++
	if r.next == len(r.ring) {
		r.next, r.full = 0, true
	}
	r.mu.Unlock()
}

// Snapshot is the JSON shape served at /api/stats (minus presence fields).
type Snapshot struct {
	RequestsServed uint64  `json:"requestsServed"`
	Errors5xx      uint64  `json:"errors5xx"`
	P50Ms          float64 `json:"p50Ms"`
	P95Ms          float64 `json:"p95Ms"`
	P99Ms          float64 `json:"p99Ms"`
	WindowSamples  int     `json:"windowSamples"`
	UptimeSec      int64   `json:"uptimeSec"`
	StartedAt      string  `json:"startedAt"`
}

// Snapshot computes current figures.
func (r *Recorder) Snapshot() Snapshot {
	r.mu.Lock()
	n := r.next
	if r.full {
		n = len(r.ring)
	}
	samples := slices.Clone(r.ring[:n])
	r.mu.Unlock()
	slices.Sort(samples)

	return Snapshot{
		RequestsServed: r.total.Load(),
		Errors5xx:      r.errors5x.Load(),
		P50Ms:          ms(Percentile(samples, 0.50)),
		P95Ms:          ms(Percentile(samples, 0.95)),
		P99Ms:          ms(Percentile(samples, 0.99)),
		WindowSamples:  n,
		UptimeSec:      int64(time.Since(r.started).Seconds()),
		StartedAt:      r.started.UTC().Format(time.RFC3339),
	}
}

func ms(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

// Percentile returns the nearest-rank percentile of sorted samples.
func Percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p*float64(len(sorted)) + 0.999999) // ceil without float noise
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}
