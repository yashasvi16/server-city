// Package presence tracks visitors walking around the city and fans their
// positions out to everyone else over WebSockets.
//
// Design: a single hub goroutine owns all state (no locks on the hot path).
// Connections send intents to it over a channel. Instead of broadcasting
// every move immediately (O(n²) messages), the hub coalesces moves and sends
// one delta per client per tick. Deltas only carry the latest position, so a
// client whose send buffer is full can safely skip a tick; it is flagged and
// receives a full snapshot next time, which self-heals any missed joins or
// leaves without unbounded buffering.
package presence

import (
	"encoding/json"
	"math"
	"sync/atomic"
	"time"
	"unicode"
)

// World bounds for positions (the city is a 120x120 square around origin).
const (
	WorldHalf    = 60.0
	MaxNameRunes = 16
	sendBuffer   = 8
)

// Peer is one visitor as seen by others.
type Peer struct {
	ID   string  `json:"id"`
	Name string  `json:"n"`
	Hue  int     `json:"h"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

type client struct {
	peer          Peer
	send          chan []byte
	needsSnapshot bool
	dirty         bool // position changed since last tick
	renamed       bool // name changed since last tick
}

type msgKind int

const (
	kJoin msgKind = iota
	kLeave
	kMove
	kRename
	kBroadcast
)

type intent struct {
	kind msgKind
	c    *client
	x, z float64
	name string
	raw  []byte
}

// Hub coordinates presence. Create with NewHub and start with Run.
type Hub struct {
	intents chan intent
	tick    time.Duration
	online  atomic.Int64
	drops   atomic.Uint64
	done    chan struct{}

	// owned by Run goroutine
	clients map[*client]struct{}
	joined  []Peer
	left    []string
	ticks   int
}

// NewHub creates a hub that broadcasts deltas every tick.
func NewHub(tick time.Duration) *Hub {
	return &Hub{
		intents: make(chan intent, 256),
		tick:    tick,
		done:    make(chan struct{}),
		clients: make(map[*client]struct{}),
	}
}

// Broadcast sends a pre-encoded message (e.g. a new guestbook entry) to
// every connected visitor. It never blocks the caller: if the hub is busy or
// stopped the event is dropped, and clients that are behind skip it. Such
// events are a live convenience; clients load the full list over HTTP.
func (h *Hub) Broadcast(raw []byte) {
	select {
	case h.intents <- intent{kind: kBroadcast, raw: raw}:
	default:
	}
}

// Online returns the number of connected visitors.
func (h *Hub) Online() int { return int(h.online.Load()) }

// Drops returns how many per-client ticks were skipped due to slow consumers.
func (h *Hub) Drops() uint64 { return h.drops.Load() }

// Done is closed when Run exits.
func (h *Hub) Done() <-chan struct{} { return h.done }

// Run processes intents until stop is closed. On exit it closes every
// client's send channel so writers can send a close frame and exit.
func (h *Hub) Run(stop <-chan struct{}) {
	defer close(h.done)
	t := time.NewTicker(h.tick)
	defer t.Stop()
	for {
		select {
		case <-stop:
			for c := range h.clients {
				close(c.send)
				delete(h.clients, c)
			}
			h.online.Store(0)
			return
		case in := <-h.intents:
			h.apply(in)
		case <-t.C:
			h.flush()
		}
	}
}

func (h *Hub) apply(in intent) {
	c := in.c
	switch in.kind {
	case kJoin:
		h.clients[c] = struct{}{}
		h.online.Store(int64(len(h.clients)))
		peers := make([]Peer, 0, len(h.clients))
		for o := range h.clients {
			if o != c {
				peers = append(peers, o.peer)
			}
		}
		h.trySend(c, mustJSON(map[string]any{"t": "welcome", "you": c.peer, "peers": peers}))
		h.joined = append(h.joined, c.peer)
	case kLeave:
		if _, ok := h.clients[c]; !ok {
			return
		}
		delete(h.clients, c)
		close(c.send)
		h.online.Store(int64(len(h.clients)))
		h.left = append(h.left, c.peer.ID)
	case kMove:
		if _, ok := h.clients[c]; ok {
			c.peer.X, c.peer.Z, c.dirty = in.x, in.z, true
		}
	case kBroadcast:
		for o := range h.clients {
			h.trySend(o, in.raw)
		}
		return
	case kRename:
		if _, ok := h.clients[c]; ok {
			c.peer.Name, c.renamed = in.name, true
		}
	}
}

// flush sends one message per client: a delta, or a snapshot if the client
// previously missed one.
func (h *Hub) flush() {
	h.ticks++
	var moved [][]any
	var renamed map[string]string
	for c := range h.clients {
		if c.dirty {
			moved = append(moved, []any{c.peer.ID, round2(c.peer.X), round2(c.peer.Z)})
			c.dirty = false
		}
		if c.renamed {
			if renamed == nil {
				renamed = map[string]string{}
			}
			renamed[c.peer.ID] = c.peer.Name
			c.renamed = false
		}
	}
	changed := len(moved) > 0 || len(renamed) > 0 || len(h.joined) > 0 || len(h.left) > 0
	if !changed && h.ticks%50 != 0 && !h.anyNeedsSnapshot() {
		return
	}
	var delta []byte
	if changed {
		delta = mustJSON(map[string]any{"t": "tick", "m": moved, "j": h.joined, "l": h.left, "u": renamed})
	}
	h.joined, h.left = nil, nil

	var snap []byte
	for c := range h.clients {
		if c.needsSnapshot || h.ticks%50 == 0 { // periodic resync every ~5s at 10Hz
			if snap == nil {
				snap = h.snapshot()
			}
			c.needsSnapshot = !h.trySend(c, snap)
			continue
		}
		if delta != nil && !h.trySend(c, delta) {
			c.needsSnapshot = true
		}
	}
}

func (h *Hub) anyNeedsSnapshot() bool {
	for c := range h.clients {
		if c.needsSnapshot {
			return true
		}
	}
	return false
}

func (h *Hub) snapshot() []byte {
	peers := make([]Peer, 0, len(h.clients))
	for c := range h.clients {
		p := c.peer
		p.X, p.Z = round2(p.X), round2(p.Z)
		peers = append(peers, p)
	}
	return mustJSON(map[string]any{"t": "snap", "peers": peers})
}

func (h *Hub) trySend(c *client, b []byte) bool {
	select {
	case c.send <- b:
		return true
	default:
		h.drops.Add(1)
		return false
	}
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only marshals internal types; a failure is a bug
	}
	return b
}

// clampPos validates a client-supplied position. NaN/Inf are rejected.
func clampPos(x, z float64) (float64, float64, bool) {
	if math.IsNaN(x) || math.IsNaN(z) || math.IsInf(x, 0) || math.IsInf(z, 0) {
		return 0, 0, false
	}
	return max(-WorldHalf, min(WorldHalf, x)), max(-WorldHalf, min(WorldHalf, z)), true
}

// SanitizeName keeps letters, digits, space, '-' and '_', trims, and caps
// length. Returns "" if nothing usable remains.
func SanitizeName(s string) string {
	out := make([]rune, 0, MaxNameRunes)
	space := false
	for _, r := range s {
		if len(out) == MaxNameRunes {
			break
		}
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_':
			out = append(out, r)
			space = false
		case unicode.IsSpace(r):
			if len(out) > 0 && !space {
				out = append(out, ' ')
				space = true
			}
		}
	}
	for len(out) > 0 && out[len(out)-1] == ' ' {
		out = out[:len(out)-1]
	}
	return string(out)
}
