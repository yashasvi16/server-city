package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/config"
	"github.com/yashasvi16/server-city/backend/internal/presence"
	"github.com/yashasvi16/server-city/backend/internal/store"
	"github.com/yashasvi16/server-city/backend/internal/wsock/wstest"
)

func newTestServer(t *testing.T, mod func(*config.Config)) (*httptest.Server, *Server) {
	t.Helper()
	cfg := config.Config{RateRPS: 100, RateBurst: 100, WSMaxTotal: 10, WSMaxPerIP: 5,
		AllowedOrigins: []string{"https://portfolio.example"}}
	if mod != nil {
		mod(&cfg)
	}
	stop := make(chan struct{})
	hub := presence.NewHub(10 * time.Millisecond)
	go hub.Run(stop)
	st, _ := store.OpenFile("", store.Options{}, nil)
	s := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), hub, st)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { close(stop); s.Presence().Wait(); ts.Close() })
	return ts, s
}

func getJSON(t *testing.T, url string, v any) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if v != nil {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	return resp
}

func TestStatsCountsRequestsAndVisitors(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	for i := 0; i < 5; i++ {
		getJSON(t, ts.URL+"/api/health", nil)
	}
	c, _, err := wstest.Dial(ts.URL, "/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.RecvText(time.Second); err != nil { // welcome
		t.Fatal(err)
	}

	var st statsResponse
	resp := getJSON(t, ts.URL+"/api/stats", &st)
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("stats must not be cached")
	}
	// 5 health + 1 ws upgrade counted before this stats request finishes.
	if st.RequestsServed != 6 {
		t.Errorf("requestsServed = %d, want 6", st.RequestsServed)
	}
	if st.WindowSamples != 5 { // ws excluded from latency window
		t.Errorf("windowSamples = %d, want 5", st.WindowSamples)
	}
	if st.VisitorsOnline != 1 {
		t.Errorf("visitorsOnline = %d, want 1", st.VisitorsOnline)
	}
}

func TestRateLimit429(t *testing.T) {
	ts, _ := newTestServer(t, func(c *config.Config) { c.RateRPS, c.RateBurst = 1, 3 })
	codes := map[int]int{}
	var last *http.Response
	for i := 0; i < 6; i++ {
		last = getJSON(t, ts.URL+"/api/health", nil)
		codes[last.StatusCode]++
	}
	if codes[200] != 3 || codes[429] != 3 {
		t.Fatalf("codes = %v", codes)
	}
	if last.Header.Get("Retry-After") == "" {
		t.Error("429 must include Retry-After")
	}
}

func TestCORS(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/stats", nil)
	req.Header.Set("Origin", "https://portfolio.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "https://portfolio.example" {
		t.Fatalf("preflight: %d %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	req.Header.Set("Origin", "https://evil.example")
	req.Method = http.MethodGet
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unknown origin must not get CORS headers")
	}
}

func TestWSOriginCheck(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	if _, resp, err := wstest.Dial(ts.URL, "/ws", http.Header{"Origin": {"https://evil.example"}}); err == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site socket should be 403, got %v", err)
	}
	c, _, err := wstest.Dial(ts.URL, "/ws", http.Header{"Origin": {"https://portfolio.example"}})
	if err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	}
	c.Close()
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name, header, value, remote, want string
	}{
		{"socket v4", "", "", "1.2.3.4:5555", "1.2.3.4"},
		{"untrusted header ignored", "", "9.9.9.9", "1.2.3.4:5555", "1.2.3.4"},
		{"xff rightmost", "X-Forwarded-For", "6.6.6.6, 7.7.7.7", "10.0.0.1:1", "7.7.7.7"},
		{"fly header", "Fly-Client-IP", "8.8.4.4", "10.0.0.1:1", "8.8.4.4"},
		{"v6 collapsed to /64", "", "", "[2001:db8:1:2:aaaa::1]:80", "2001:db8:1:2::/64"},
		{"v4-mapped v6", "", "", "[::ffff:1.2.3.4]:80", "1.2.3.4"},
		{"garbage header", "Fly-Client-IP", "not-an-ip", "10.0.0.1:1", "invalid"},
		{"xff skip one proxy (Render)", "X-Forwarded-For:1", "6.6.6.6, 7.7.7.7, 10.1.2.3", "10.0.0.1:1", "7.7.7.7"},
		{"xff skip, spoofed left part ignored", "X-Forwarded-For:1", "1.1.1.1, 9.9.9.9, 7.7.7.7, 10.1.2.3", "10.0.0.1:1", "7.7.7.7"},
		{"render behind cloudflare: xff skip two", "X-Forwarded-For:2", "6.6.6.6, 104.22.60.146, 10.29.117.6", "10.0.0.1:1", "6.6.6.6"},
		{"render behind cloudflare: cf header", "CF-Connecting-IP", "6.6.6.6", "10.0.0.1:1", "6.6.6.6"},
		{"cf header v6 collapsed", "CF-Connecting-IP", "2001:db8:1:2:aaaa::9", "10.0.0.1:1", "2001:db8:1:2::/64"},
		{"xff skip beyond list falls back to socket", "X-Forwarded-For:3", "7.7.7.7, 10.1.2.3", "1.2.3.4:5", "1.2.3.4"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tc.remote
			if tc.value != "" {
				h, _, _ := strings.Cut(tc.header, ":")
				if h == "" {
					h = "X-Forwarded-For"
				}
				r.Header.Set(h, tc.value)
			}
			if got := ClientIP(r, tc.header); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestPanicRecovered(t *testing.T) {
	_, s := newTestServer(t, nil)
	h := s.recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 500 {
		t.Fatalf("code %d", rec.Code)
	}
}

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("city"), 0o644)
	os.WriteFile(filepath.Join(dir, "resume.html"), []byte("resume"), 0o644)
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "a.js"), []byte("js"), 0o644)
	ts, _ := newTestServer(t, func(c *config.Config) { c.StaticDir = dir })

	get := func(p string) (*http.Response, string) {
		resp, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}
	if _, b := get("/resume"); b != "resume" {
		t.Errorf("/resume -> %q", b)
	}
	if resp, _ := get("/assets/a.js"); resp.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Error("hashed assets should be immutable-cached")
	}
	if resp, _ := get("/../../etc/passwd"); resp.StatusCode == 200 {
		t.Error("path traversal must not succeed")
	}
}

func TestStaticPrecompressed(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "assets", "city.glb"), []byte("plain"), 0o644)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte("plain"))
	zw.Close()
	os.WriteFile(filepath.Join(dir, "assets", "city.glb.gz"), buf.Bytes(), 0o644)
	ts, _ := newTestServer(t, func(c *config.Config) { c.StaticDir = dir })

	fetch := func(ae string) *http.Response {
		req, _ := http.NewRequest("GET", ts.URL+"/assets/city.glb", nil)
		req.Header.Set("Accept-Encoding", ae) // set explicitly: disables Go's transparent decoding
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := fetch("br, gzip;q=0.8")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(body, buf.Bytes()) {
		t.Fatalf("want gzipped body, got encoding %q", resp.Header.Get("Content-Encoding"))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "model/gltf-binary" {
		t.Errorf("content type %q", ct)
	}
	if resp.Header.Get("Vary") != "Accept-Encoding" {
		t.Error("missing Vary")
	}
	for _, ae := range []string{"identity", "gzip;q=0"} {
		resp = fetch(ae)
		body, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.Header.Get("Content-Encoding") != "" || string(body) != "plain" {
			t.Errorf("%q: want plain body, got %q", ae, body)
		}
	}
}
