package presence

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/wsock"
	"github.com/yashasvi16/server-city/backend/internal/wsock/wstest"
)

func testCfg() ServerConfig {
	return ServerConfig{
		MaxTotal: 50, MaxPerIP: 3, MsgRate: 20, MsgBurst: 5, MaxStrikes: 3,
		PingInterval: time.Second, ReadTimeout: 5 * time.Second,
		WS: wsock.Options{MaxMessage: 512},
	}
}

type fixture struct {
	hub  *Hub
	srv  *Server
	http *httptest.Server
	stop chan struct{}
}

func start(t *testing.T, cfg ServerConfig) *fixture {
	t.Helper()
	f := &fixture{hub: NewHub(20 * time.Millisecond), stop: make(chan struct{})}
	go f.hub.Run(f.stop)
	f.srv = NewServer(f.hub, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := r.Header.Get("X-Test-IP")
		if ip == "" {
			ip = "1.1.1.1"
		}
		f.srv.ServeWS(w, r, ip)
	}))
	t.Cleanup(func() {
		select {
		case <-f.stop:
		default:
			close(f.stop)
		}
		f.srv.Wait()
		f.http.Close()
	})
	return f
}

func (f *fixture) dial(t *testing.T, ip string) *wstest.Client {
	t.Helper()
	c, _, err := wstest.Dial(f.http.URL, "/ws", http.Header{"X-Test-IP": {ip}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

type serverMsg struct {
	T     string            `json:"t"`
	You   Peer              `json:"you"`
	Peers []Peer            `json:"peers"`
	M     [][]any           `json:"m"`
	J     []Peer            `json:"j"`
	L     []string          `json:"l"`
	U     map[string]string `json:"u"`
}

func recv(t *testing.T, c *wstest.Client) serverMsg {
	t.Helper()
	p, err := c.RecvText(2 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var m serverMsg
	if err := json.Unmarshal(p, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// waitFor reads messages until pred matches.
func waitFor(t *testing.T, c *wstest.Client, pred func(serverMsg) bool) serverMsg {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		m := recv(t, c)
		if pred(m) {
			return m
		}
	}
	t.Fatal("condition not met")
	return serverMsg{}
}

func TestJoinMoveRenameLeave(t *testing.T) {
	f := start(t, testCfg())
	a := f.dial(t, "10.0.0.1")
	wa := recv(t, a)
	if wa.T != "welcome" || wa.You.ID == "" || len(wa.Peers) != 0 {
		t.Fatalf("bad welcome %+v", wa)
	}

	b := f.dial(t, "10.0.0.2")
	wb := recv(t, b)
	if len(wb.Peers) != 1 || wb.Peers[0].ID != wa.You.ID {
		t.Fatalf("b should see a: %+v", wb)
	}
	waitFor(t, a, func(m serverMsg) bool { return hasPeer(m.J, wb.You.ID) })

	// Out-of-bounds move gets clamped; name gets sanitized.
	b.SendText(`{"t":"move","x":999,"z":-3.14159}`)
	b.SendText(`{"t":"name","n":"  <b>Neo</b>  !! "}`)
	// Move and rename may arrive in the same tick or in consecutive ones.
	var moved []any
	gotName := ""
	waitFor(t, a, func(m serverMsg) bool {
		if len(m.M) == 1 {
			moved = m.M[0]
		}
		if n, ok := m.U[wb.You.ID]; ok {
			gotName = n
		}
		return moved != nil && gotName != ""
	})
	if moved[0] != wb.You.ID || moved[1].(float64) != WorldHalf || moved[2].(float64) != -3.14 {
		t.Fatalf("bad move delta %v", moved)
	}
	if gotName != "bNeob" {
		t.Fatalf("name = %q", gotName)
	}

	if f.hub.Online() != 2 {
		t.Fatalf("online = %d", f.hub.Online())
	}
	b.Close()
	waitFor(t, a, func(m serverMsg) bool { return len(m.L) == 1 && m.L[0] == wb.You.ID })
	if f.hub.Online() != 1 {
		t.Fatalf("online after leave = %d", f.hub.Online())
	}
}

func TestInvalidInputIgnored(t *testing.T) {
	f := start(t, testCfg())
	a := f.dial(t, "10.0.0.1")
	recv(t, a)
	b := f.dial(t, "10.0.0.2")
	recv(t, b)
	waitFor(t, a, func(m serverMsg) bool { return hasPeer(m.J, "") && len(m.J) > 0 })
	// NaN cannot be expressed in JSON; missing fields and wrong types must be ignored.
	b.SendText(`{"t":"move","x":1}`)
	b.SendText(`{"t":"move","x":"1","z":2}`)
	b.SendText(`{"t":"name","n":"!!!"}`)
	b.SendText(`{"t":"move","x":5,"z":6}`)
	m := waitFor(t, a, func(m serverMsg) bool { return len(m.M) > 0 || len(m.U) > 0 })
	if len(m.U) != 0 || m.M[0][1].(float64) != 5 {
		t.Fatalf("unexpected delta %+v", m)
	}
}

func TestPerIPLimit(t *testing.T) {
	f := start(t, testCfg())
	for i := 0; i < 3; i++ {
		f.dial(t, "9.9.9.9")
	}
	_, resp, err := wstest.Dial(f.http.URL, "/ws", http.Header{"X-Test-IP": {"9.9.9.9"}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("4th socket from same IP should get 429, got %v %v", resp, err)
	}
	f.dial(t, "8.8.8.8") // other IPs unaffected
}

func TestFloodDisconnects(t *testing.T) {
	f := start(t, testCfg())
	c := f.dial(t, "7.7.7.7")
	recv(t, c)
	for i := 0; i < 40; i++ {
		c.SendText(`{"t":"move","x":1,"z":1}`)
	}
	for {
		_, err := c.RecvText(2 * time.Second)
		var ce *wstest.CloseErr
		if errors.As(err, &ce) {
			if ce.Code != wsock.ClosePolicyViolation {
				t.Fatalf("close code %d", ce.Code)
			}
			return
		}
		if err != nil {
			t.Fatalf("expected policy close, got %v", err)
		}
	}
}

func TestSlowConsumerGetsSnapshot(t *testing.T) {
	h := NewHub(time.Hour) // drive ticks manually
	slow := &client{peer: Peer{ID: "slow"}, send: make(chan []byte, 1)}
	mover := &client{peer: Peer{ID: "mover"}, send: make(chan []byte, 64)}
	h.apply(intent{kind: kJoin, c: slow})  // fills slow's 1-slot buffer with welcome
	h.apply(intent{kind: kJoin, c: mover}) // welcome for mover
	h.apply(intent{kind: kMove, c: mover, x: 1, z: 2})
	h.flush()
	if !slow.needsSnapshot || h.Drops() == 0 {
		t.Fatal("slow client should be flagged after a dropped delta")
	}
	<-slow.send // consumer catches up
	h.flush()
	msg := <-slow.send
	var m serverMsg
	json.Unmarshal(msg, &m)
	if m.T != "snap" || len(m.Peers) != 2 {
		t.Fatalf("expected snapshot with 2 peers, got %s", msg)
	}
}

func TestShutdownClosesSockets(t *testing.T) {
	f := start(t, testCfg())
	var clients []*wstest.Client
	for i := 0; i < 5; i++ {
		c := f.dial(t, string(rune('a'+i)))
		recv(t, c)
		clients = append(clients, c)
	}
	close(f.stop)
	var wg sync.WaitGroup
	for _, c := range clients {
		wg.Add(1)
		go func(c *wstest.Client) {
			defer wg.Done()
			for {
				_, err := c.RecvText(3 * time.Second)
				var ce *wstest.CloseErr
				if errors.As(err, &ce) {
					if ce.Code != wsock.CloseGoingAway {
						t.Errorf("close code %d", ce.Code)
					}
					return
				}
				if err != nil {
					t.Errorf("expected close frame: %v", err)
					return
				}
			}
		}(c)
	}
	wg.Wait()
	done := make(chan struct{})
	go func() { f.srv.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("socket goroutines did not exit")
	}
}

func hasPeer(ps []Peer, id string) bool {
	for _, p := range ps {
		if id == "" || p.ID == id {
			return true
		}
	}
	return false
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"Yash":                  "Yash",
		"  a   b  ":             "a b",
		"<script>":              "script",
		"ヤシャスヴィ":                "ヤシャスヴィ",
		"abcdefghijklmnopqrstu": "abcdefghijklmnop",
		"!!!":                   "",
	}
	for in, want := range cases {
		if got := SanitizeName(in); got != want {
			t.Errorf("SanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Regression: sockets arriving while Wait() runs must be refused, not race
// with the WaitGroup.
func TestConnectDuringShutdownIsRefused(t *testing.T) {
	f := start(t, testCfg())
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, _, err := wstest.Dial(f.http.URL, "/ws", http.Header{"X-Test-IP": {string(rune('A' + i))}})
			if err == nil {
				c.Close()
			}
		}(i)
	}
	close(f.stop)
	f.srv.Wait()
	wg.Wait()
	if _, resp, err := wstest.Dial(f.http.URL, "/ws", nil); err == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("socket after shutdown should get 503, got %v", err)
	}
}

// Regression: a join can land in the hub's intent buffer after the hub has
// stopped, so that client's send channel is never closed. Its writer must
// still exit once the hub is done, or Server.Wait hangs on shutdown.
func TestDrainStopsWhenHubDone(t *testing.T) {
	ch := make(chan []byte, 1)
	done := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		drain(ch, done)
		close(exited)
	}()
	ch <- []byte("x")
	select {
	case <-exited:
		t.Fatal("drain returned while the hub was still running")
	case <-time.After(50 * time.Millisecond):
	}
	close(done)
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("drain did not return after the hub stopped")
	}
}
