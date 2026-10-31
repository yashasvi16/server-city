// Package config loads server settings from environment variables.
// Every setting has a safe default so `go run ./cmd/server` just works.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr           string   // ADDR, default ":8080"
	AllowedOrigins []string // ALLOWED_ORIGINS, comma-separated; empty = same-origin only
	ClientIPHeader string   // CLIENT_IP_HEADER, e.g. "Fly-Client-IP" or "X-Forwarded-For"; empty = use socket address
	StaticDir      string   // STATIC_DIR, serve the built frontend from here if set
	LogLevel       string   // LOG_LEVEL: debug|info|warn|error

	RateRPS   float64 // RATE_RPS, sustained requests/sec per IP
	RateBurst int     // RATE_BURST

	WSMaxTotal int // WS_MAX_TOTAL
	WSMaxPerIP int // WS_MAX_PER_IP

	ShutdownTimeout time.Duration // SHUTDOWN_TIMEOUT

	DataDir   string // DATA_DIR, where the guestbook/leaderboard log lives; "" = memory only
	RunSecret string // RUN_SECRET, HMAC key for game-run tokens; empty = random per process
}

func Load() (Config, error) {
	c := Config{
		Addr:            env("ADDR", ":8080"),
		ClientIPHeader:  os.Getenv("CLIENT_IP_HEADER"),
		StaticDir:       os.Getenv("STATIC_DIR"),
		LogLevel:        env("LOG_LEVEL", "info"),
		RateRPS:         10,
		RateBurst:       40,
		WSMaxTotal:      500,
		WSMaxPerIP:      4,
		ShutdownTimeout: 10 * time.Second,
		DataDir:         env("DATA_DIR", "data"),
		RunSecret:       os.Getenv("RUN_SECRET"),
	}
	if c.DataDir == "memory" {
		c.DataDir = ""
	}
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, strings.TrimRight(o, "/"))
		}
	}
	var err error
	if c.RateRPS, err = envFloat("RATE_RPS", c.RateRPS); err != nil {
		return c, err
	}
	if c.RateBurst, err = envInt("RATE_BURST", c.RateBurst); err != nil {
		return c, err
	}
	if c.WSMaxTotal, err = envInt("WS_MAX_TOTAL", c.WSMaxTotal); err != nil {
		return c, err
	}
	if c.WSMaxPerIP, err = envInt("WS_MAX_PER_IP", c.WSMaxPerIP); err != nil {
		return c, err
	}
	if v := os.Getenv("SHUTDOWN_TIMEOUT"); v != "" {
		if c.ShutdownTimeout, err = time.ParseDuration(v); err != nil {
			return c, fmt.Errorf("SHUTDOWN_TIMEOUT: %w", err)
		}
	}
	return c, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) (int, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", k)
	}
	return n, nil
}

func envFloat(k string, def float64) (float64, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f <= 0 {
		return 0, fmt.Errorf("%s must be a positive number", k)
	}
	return f, nil
}
