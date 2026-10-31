// Package api wires HTTP routes, middleware and handlers.
package api

import (
	"encoding/json"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/config"
	"github.com/yashasvi16/server-city/backend/internal/metrics"
	"github.com/yashasvi16/server-city/backend/internal/presence"
	"github.com/yashasvi16/server-city/backend/internal/ratelimit"
	"github.com/yashasvi16/server-city/backend/internal/runs"
	"github.com/yashasvi16/server-city/backend/internal/store"
	"github.com/yashasvi16/server-city/backend/internal/wsock"
)

// Version is set at build time with -ldflags "-X .../api.Version=...".
var Version = "dev"

// Server holds dependencies for the HTTP handlers.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	metrics  *metrics.Recorder
	limiter  *ratelimit.Limiter
	hub      *presence.Hub
	presence *presence.Server
	store    store.Store
	runs     *runs.Issuer

	guestbookLimiter *ratelimit.Limiter // 1 entry per 20s per IP, burst 3
	scoreLimiter     *ratelimit.Limiter // 1 score per 3s per IP, burst 3
}

// New builds the API server.
func New(cfg config.Config, log *slog.Logger, hub *presence.Hub, st store.Store) *Server {
	s := &Server{
		cfg:              cfg,
		log:              log,
		metrics:          metrics.New(2048),
		limiter:          ratelimit.New(cfg.RateRPS, cfg.RateBurst, 10*time.Minute, 100_000),
		hub:              hub,
		store:            st,
		runs:             runs.New(cfg.RunSecret, 2*time.Hour),
		guestbookLimiter: ratelimit.New(1.0/20, 3, 30*time.Minute, 50_000),
		scoreLimiter:     ratelimit.New(1.0/3, 3, 30*time.Minute, 50_000),
	}
	s.presence = presence.NewServer(hub, presence.ServerConfig{
		MaxTotal: cfg.WSMaxTotal, MaxPerIP: cfg.WSMaxPerIP,
		MsgRate: 15, MsgBurst: 30, MaxStrikes: 60,
		PingInterval: 25 * time.Second, ReadTimeout: 70 * time.Second,
		WS: wsock.Options{MaxMessage: 1024, CheckOrigin: s.originAllowedWS},
	}, log)
	return s
}

// Sweep drops idle rate-limit buckets; main calls it periodically.
func (s *Server) Sweep() {
	s.limiter.Sweep()
	s.guestbookLimiter.Sweep()
	s.scoreLimiter.Sweep()
}

// Presence exposes the socket server so main can wait for it at shutdown.
func (s *Server) Presence() *presence.Server { return s.presence }

// Handler returns the full middleware-wrapped router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/stats", s.handleStats)
	mux.HandleFunc("GET /api/guestbook", s.handleGuestbookList)
	mux.HandleFunc("POST /api/guestbook", s.handleGuestbookPost)
	mux.HandleFunc("GET /api/leaderboard", s.handleLeaderboard)
	mux.HandleFunc("POST /api/leaderboard", s.handleScorePost)
	mux.HandleFunc("POST /api/runs", s.handleRunStart)
	mux.HandleFunc("GET /api/whoami", s.handleWhoami)
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		s.presence.ServeWS(w, r, ClientIP(r, s.cfg.ClientIPHeader))
	})
	if s.cfg.StaticDir != "" {
		mux.Handle("GET /", staticHandler(s.cfg.StaticDir))
	}
	// Order (outermost first): recover -> log+metrics -> security headers -> CORS -> rate limit.
	var h http.Handler = mux
	h = s.rateLimit(h)
	h = s.cors(h)
	h = securityHeaders(h)
	h = s.observe(h)
	h = s.recoverer(h)
	return h
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": Version})
}

type statsResponse struct {
	metrics.Snapshot
	VisitorsOnline int    `json:"visitorsOnline"`
	PresenceDrops  uint64 `json:"presenceDrops"`
	Version        string `json:"version"`
}

func (s *Server) handleStats(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, statsResponse{
		Snapshot:       s.metrics.Snapshot(),
		VisitorsOnline: s.hub.Online(),
		PresenceDrops:  s.hub.Drops(),
		Version:        Version,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- middleware -------------------------------------------------------------

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach Hijack for WebSocket upgrades.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		isWS := r.URL.Path == "/ws"
		if isWS {
			// Count sockets when they open; their lifetime would distort
			// latency percentiles, so they never enter the latency window.
			s.metrics.Count()
		}
		next.ServeHTTP(sw, r)
		d := time.Since(start)
		if sw.status == 0 {
			sw.status = http.StatusSwitchingProtocols // hijacked socket
		}
		if !isWS {
			s.metrics.Observe(d, sw.status)
		}
		lvl := slog.LevelInfo
		if sw.status >= 500 {
			lvl = slog.LevelError
		} else if r.URL.Path == "/api/health" || r.URL.Path == "/api/stats" {
			lvl = slog.LevelDebug // polled constantly; keep logs readable
		}
		s.log.Log(r.Context(), lvl, "http",
			"method", r.Method, "path", r.URL.Path, "status", sw.status,
			"dur_ms", float64(d.Microseconds())/1000, "bytes", sw.bytes,
			"ip", ClientIP(r, s.cfg.ClientIPHeader))
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.log.Error("panic", "err", v, "path", r.URL.Path, "stack", string(debug.Stack()))
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	return slices.Contains(s.cfg.AllowedOrigins, strings.TrimRight(origin, "/"))
}

// originAllowedWS accepts same-host or configured origins. Browsers always
// send Origin on WebSocket handshakes, so this blocks cross-site hijacking.
func (s *Server) originAllowedWS(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true // non-browser client (curl, load test)
	}
	if s.originAllowed(o) {
		return true
	}
	i := strings.Index(o, "://")
	return i >= 0 && strings.EqualFold(o[i+3:], r.Host)
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && s.originAllowed(o) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", o)
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Content-Type")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/ws" {
			next.ServeHTTP(w, r) // static assets are cheap; don't throttle page loads
			return
		}
		ok, retry := s.limiter.Allow(ClientIP(r, s.cfg.ClientIPHeader))
		if !ok {
			secs := int(retry.Seconds() + 0.999)
			w.Header().Set("Retry-After", strconv.Itoa(max(1, secs)))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// staticHandler serves the built frontend, with long caching for hashed
// assets and a .html fallback (so /resume serves resume.html).
func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Clean(r.URL.Path)
		if strings.HasPrefix(p, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if filepath.Ext(p) == "" && p != "/" {
			if _, err := os.Stat(filepath.Join(dir, p+".html")); err == nil {
				r.URL.Path = p + ".html"
			}
		}
		if strings.HasPrefix(p, "/assets/") && serveGzipped(w, r, dir, p) {
			return
		}
		fs.ServeHTTP(w, r)
	})
}

func init() {
	_ = mime.AddExtensionType(".glb", "model/gltf-binary")
}

// serveGzipped serves a build-time precompressed sibling (name.gz) when the
// client accepts gzip. The 3D city model shrinks from ~1.6 MB to ~0.6 MB.
func serveGzipped(w http.ResponseWriter, r *http.Request, dir, p string) bool {
	if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		return false
	}
	f, err := os.Open(filepath.Join(dir, filepath.FromSlash(p)+".gz"))
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	ct := mime.TypeByExtension(filepath.Ext(p))
	if ct == "" {
		ct = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	http.ServeContent(w, r, "", st.ModTime(), f)
	return true
}

func acceptsGzip(ae string) bool {
	for _, part := range strings.Split(ae, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		q := strings.ReplaceAll(strings.TrimSpace(params), " ", "")
		return q != "q=0" && q != "q=0.0" && q != "q=0.00" && q != "q=0.000"
	}
	return false
}

// handleWhoami shows a visitor the address the server keys its rate limits
// on, next to the raw forwarding headers. It exists to check the
// CLIENT_IP_HEADER setting after deploying behind a new host's proxies.
func (s *Server) handleWhoami(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"ip":             ClientIP(r, s.cfg.ClientIPHeader),
		"clientIPHeader": s.cfg.ClientIPHeader,
		"xForwardedFor":  r.Header.Get("X-Forwarded-For"),
		"trueClientIP":   r.Header.Get("True-Client-IP"),
		"cfConnectingIP": r.Header.Get("CF-Connecting-IP"),
	})
}
