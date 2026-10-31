// Command server runs the Living Server City backend: presence WebSockets,
// live stats, and (optionally) the built frontend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/api"
	"github.com/yashasvi16/server-city/backend/internal/config"
	"github.com/yashasvi16/server-city/backend/internal/presence"
	"github.com/yashasvi16/server-city/backend/internal/store"
)

func main() {
	// `server healthcheck` lets a distroless container (no curl) run its own
	// Docker HEALTHCHECK against the local listener.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get("http://" + addr + "/api/health")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.LogLevel))
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.OpenFile(cfg.DataDir, store.Options{}, log)
	if err != nil {
		return err
	}
	if cfg.DataDir == "" {
		log.Warn("DATA_DIR=memory: guestbook and leaderboard will not survive a restart")
	}

	hubStop := make(chan struct{})
	hub := presence.NewHub(100 * time.Millisecond) // 10 Hz presence ticks
	go hub.Run(hubStop)

	apiSrv := api.New(cfg, log, hub, st)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           apiSrv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	go func() { // janitor for idle rate-limit buckets
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				apiSrv.Sweep()
			}
		}
	}()

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr, "version", api.Version,
			"static", cfg.StaticDir, "origins", cfg.AllowedOrigins)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down", "timeout", cfg.ShutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	// 1. Stop accepting new HTTP requests and drain in-flight ones.
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown", "err", err)
	}
	// 2. Stop the hub: every socket gets a 1001 Going Away close frame.
	close(hubStop)
	// 3. Wait for socket goroutines (Shutdown doesn't track hijacked conns).
	done := make(chan struct{})
	go func() { apiSrv.Presence().Wait(); close(done) }()
	select {
	case <-done:
	case <-shutdownCtx.Done():
		log.Warn("sockets did not close before timeout")
	}
	// 4. Nothing can write any more: flush and close the store.
	if err := st.Close(); err != nil {
		log.Error("store close", "err", err)
	}
	log.Info("bye")
	return nil
}
