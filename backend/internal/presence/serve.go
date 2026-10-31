package presence

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/ratelimit"
	"github.com/yashasvi16/server-city/backend/internal/wsock"
)

// ServerConfig bounds resource use per visitor.
type ServerConfig struct {
	MaxTotal     int           // max concurrent sockets overall
	MaxPerIP     int           // max concurrent sockets per client IP
	MsgRate      float64       // sustained client messages/sec
	MsgBurst     int           // burst of client messages
	MaxStrikes   int           // rate-limit violations before disconnect
	PingInterval time.Duration // server ping cadence
	ReadTimeout  time.Duration // no traffic (incl. pong) for this long => drop
	WS           wsock.Options
}

// Server upgrades HTTP requests and attaches sockets to a Hub.
type Server struct {
	hub *Hub
	cfg ServerConfig
	log *slog.Logger

	mu      sync.Mutex
	total   int
	perIP   map[string]int
	closing bool
	// wg counts sockets. Add happens under mu and only while !closing, so it
	// can never race with Wait (sync.WaitGroup forbids Add concurrent with
	// Wait when the counter may be zero).
	wg sync.WaitGroup
}

// NewServer creates a presence socket server.
func NewServer(h *Hub, cfg ServerConfig, log *slog.Logger) *Server {
	return &Server{hub: h, cfg: cfg, log: log, perIP: map[string]int{}}
}

// Wait stops new sockets from registering, then blocks until every socket
// goroutine has exited (http.Server.Shutdown doesn't track hijacked conns).
func (s *Server) Wait() {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.wg.Wait()
}

var errFull = errors.New("full")

func (s *Server) acquire(ip string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return http.StatusServiceUnavailable, errFull
	}
	if s.total >= s.cfg.MaxTotal {
		return http.StatusServiceUnavailable, errFull
	}
	if s.perIP[ip] >= s.cfg.MaxPerIP {
		return http.StatusTooManyRequests, errFull
	}
	s.total++
	s.perIP[ip]++
	s.wg.Add(1)
	return 0, nil
}

func (s *Server) release(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.total--
	if s.perIP[ip]--; s.perIP[ip] <= 0 {
		delete(s.perIP, ip)
	}
	s.wg.Done()
}

// submit hands an intent to the hub unless it has stopped.
func (s *Server) submit(in intent) bool {
	select {
	case s.hub.intents <- in:
		return true
	case <-s.hub.done:
		return false
	}
}

type clientMsg struct {
	T string   `json:"t"`
	X *float64 `json:"x"`
	Z *float64 `json:"z"`
	N string   `json:"n"`
}

// ServeWS handles one visitor socket. ip is the already-resolved client IP.
func (s *Server) ServeWS(w http.ResponseWriter, r *http.Request, ip string) {
	select {
	case <-s.hub.done:
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	default:
	}
	if status, err := s.acquire(ip); err != nil {
		http.Error(w, "too many connections", status)
		return
	}
	defer s.release(ip)
	conn, err := wsock.Upgrade(w, r, s.cfg.WS)
	if err != nil {
		return
	}

	id := randomID()
	c := &client{
		peer: Peer{ID: id, Name: "visitor-" + id[:4], Hue: randInt(360), X: float64(randInt(9)) - 4, Z: 40},
		send: make(chan []byte, sendBuffer),
	}
	if !s.submit(intent{kind: kJoin, c: c}) {
		_ = conn.CloseWith(wsock.CloseGoingAway, "shutting down")
		return
	}
	s.log.Debug("presence join", "id", id)

	writerDone := make(chan struct{})
	go s.writeLoop(conn, c, writerDone)

	s.readLoop(conn, c)

	s.submit(intent{kind: kLeave, c: c}) // closes c.send -> writer exits
	_ = conn.Close()
	<-writerDone
	s.log.Debug("presence leave", "id", id)
}

func (s *Server) writeLoop(conn *wsock.Conn, c *client, done chan<- struct{}) {
	defer close(done)
	ping := time.NewTicker(s.cfg.PingInterval)
	defer ping.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.CloseWith(wsock.CloseGoingAway, "bye")
				return
			}
			if err := conn.WriteText(msg, 5*time.Second); err != nil {
				_ = conn.Close()
				drain(c.send, s.hub.done)
				return
			}
		case <-ping.C:
			if err := conn.Ping(5 * time.Second); err != nil {
				_ = conn.Close()
				drain(c.send, s.hub.done)
				return
			}
		case <-s.hub.done:
			// The hub has stopped. It normally closes c.send on the way out,
			// but a join that raced with shutdown may never have reached it,
			// and then nobody would close c.send.
			_ = conn.CloseWith(wsock.CloseGoingAway, "shutting down")
			return
		}
	}
}

// drain discards messages until the hub closes the channel, so the hub's
// non-blocking sends keep succeeding/dropping cleanly. Once the hub has
// stopped nothing sends any more, so drain returns then too (the channel may
// never be closed if this client's join raced with shutdown).
func drain(ch <-chan []byte, hubDone <-chan struct{}) {
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-hubDone:
			return
		}
	}
}

func (s *Server) readLoop(conn *wsock.Conn, c *client) {
	bucket := ratelimit.NewBucket(s.cfg.MsgRate, s.cfg.MsgBurst)
	strikes := 0
	extend := func() { _ = conn.SetReadDeadline(time.Now().Add(s.cfg.ReadTimeout)) }
	extend()
	for {
		op, data, err := conn.ReadMessage(extend)
		if err != nil {
			return
		}
		extend()
		if op != wsock.OpText {
			_ = conn.CloseWith(wsock.CloseUnsupportedData, "text only")
			return
		}
		if !bucket.AllowAt(time.Now()) {
			if strikes++; strikes > s.cfg.MaxStrikes {
				_ = conn.CloseWith(wsock.ClosePolicyViolation, "rate limited")
				return
			}
			continue
		}
		var m clientMsg
		if json.Unmarshal(data, &m) != nil {
			if strikes++; strikes > s.cfg.MaxStrikes {
				_ = conn.CloseWith(wsock.ClosePolicyViolation, "bad messages")
				return
			}
			continue
		}
		switch m.T {
		case "move":
			if m.X == nil || m.Z == nil {
				continue
			}
			if x, z, ok := clampPos(*m.X, *m.Z); ok {
				s.submit(intent{kind: kMove, c: c, x: x, z: z})
			}
		case "name":
			if n := SanitizeName(m.N); n != "" {
				s.submit(intent{kind: kRename, c: c, name: n})
			}
		}
	}
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func randInt(n int64) int {
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}
