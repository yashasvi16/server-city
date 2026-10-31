package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/config"
	"github.com/yashasvi16/server-city/backend/internal/ratelimit"
	"github.com/yashasvi16/server-city/backend/internal/wsock/wstest"
)

func post(t *testing.T, url, ctype, body string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Post(url, ctype, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func postJSON(t *testing.T, url string, v any) (int, map[string]any) {
	b, _ := json.Marshal(v)
	return post(t, url, "application/json", string(b))
}

func TestGuestbookPostAndList(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	code, e := postJSON(t, ts.URL+"/api/guestbook", map[string]string{"name": "  Asha ​", "message": "Loved the\nqueue station!"})
	if code != http.StatusCreated || e["name"] != "Asha" || e["message"] != "Loved the queue station!" || e["id"] == "" {
		t.Fatalf("post: %d %v", code, e)
	}
	code, e = postJSON(t, ts.URL+"/api/guestbook", map[string]string{"message": "Second, no name"})
	if code != http.StatusCreated || e["name"] != "Anonymous visitor" {
		t.Fatalf("anonymous: %d %v", code, e)
	}
	var list struct{ Entries []map[string]any }
	getJSON(t, ts.URL+"/api/guestbook?limit=10", &list)
	if len(list.Entries) != 2 || list.Entries[0]["message"] != "Second, no name" {
		t.Fatalf("list newest-first: %+v", list.Entries)
	}
}

func TestGuestbookValidation(t *testing.T) {
	ts, _ := newTestServer(t, func(c *config.Config) {})
	cases := []struct {
		name, ctype, body string
		code              int
		field             string
	}{
		{"empty message", "application/json", `{"message":"   "}`, 422, "message"},
		{"too long", "application/json", `{"message":"` + strings.Repeat("a b ", 71) + `"}`, 422, "message"},
		{"blocked word", "application/json", `{"message":"you are a b1tch"}`, 422, "message"},
		{"blocked name", "application/json", `{"name":"chutiya","message":"hello"}`, 422, "name"},
		{"link", "application/json", `{"message":"visit spam.com now"}`, 422, "message"},
		{"unknown field", "application/json", `{"message":"hi","admin":true}`, 400, ""},
		{"two objects", "application/json", `{"message":"hi"}{"message":"again"}`, 400, ""},
		{"form post", "application/x-www-form-urlencoded", `message=hi`, 415, ""},
		{"huge body", "application/json", `{"message":"` + strings.Repeat("x", 5000) + `"}`, 413, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Fresh server per case so the write limiter doesn't interfere.
			ts, _ := newTestServer(t, nil)
			code, out := post(t, ts.URL+"/api/guestbook", c.ctype, c.body)
			if code != c.code {
				t.Fatalf("code %d want %d (%v)", code, c.code, out)
			}
			if c.field != "" && out["field"] != c.field {
				t.Fatalf("field %v want %s", out["field"], c.field)
			}
			if out["error"] == "" {
				t.Fatal("errors must explain what went wrong")
			}
		})
	}
	_ = ts
}

func TestGuestbookDuplicateAndRateLimit(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	if code, _ := postJSON(t, ts.URL+"/api/guestbook", map[string]string{"message": "same thing"}); code != 201 {
		t.Fatal(code)
	}
	if code, _ := postJSON(t, ts.URL+"/api/guestbook", map[string]string{"message": "SAME   thing"}); code != http.StatusConflict {
		t.Fatalf("duplicate: %d", code)
	}
	postJSON(t, ts.URL+"/api/guestbook", map[string]string{"message": "third"})
	code, out := postJSON(t, ts.URL+"/api/guestbook", map[string]string{"message": "fourth"})
	if code != http.StatusTooManyRequests || !strings.Contains(out["error"].(string), "try again") {
		t.Fatalf("burst of 3 then limited: %d %v", code, out)
	}
}

func TestGuestbookBroadcastsToSockets(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	c, _, err := wstest.Dial(ts.URL, "/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.RecvText(time.Second) // welcome
	postJSON(t, ts.URL+"/api/guestbook", map[string]string{"name": "Ravi", "message": "Hello city"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p, err := c.RecvText(time.Second)
		if err != nil {
			t.Fatal(err)
		}
		var m struct {
			T string
			E map[string]any
		}
		json.Unmarshal(p, &m)
		if m.T == "gb" {
			if m.E["message"] != "Hello city" {
				t.Fatalf("broadcast %v", m.E)
			}
			return
		}
	}
	t.Fatal("no guestbook broadcast")
}

func TestLeaderboardFlow(t *testing.T) {
	ts, s := newTestServer(t, nil)
	s.scoreLimiter = ratelimit.New(1000, 1000, time.Minute, 100) // this test is about validation, not limits
	now := time.Now()
	var mu sync.Mutex
	s.runs.SetClock(func() time.Time { mu.Lock(); defer mu.Unlock(); return now })
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }

	start := func() string {
		code, out := postJSON(t, ts.URL+"/api/runs", map[string]string{"board": "defense"})
		if code != http.StatusCreated {
			t.Fatalf("start run: %d %v", code, out)
		}
		return out["token"].(string)
	}
	submit := func(tok string, name string, score, wave int, ms int64) (int, map[string]any) {
		return postJSON(t, ts.URL+"/api/leaderboard", map[string]any{
			"board": "defense", "name": name, "score": score, "wave": wave, "durationMs": ms, "token": tok})
	}

	tok := start()
	advance(2 * time.Minute)
	code, res := submit(tok, "Asha", 5000, 5, 100_000)
	if code != 200 || res["rank"] != 1.0 || res["improved"] != true {
		t.Fatalf("first score: %d %v", code, res)
	}
	if code, _ := submit(tok, "Asha", 5000, 5, 100_000); code != http.StatusConflict {
		t.Fatalf("replayed token: %d", code)
	}

	tok = start()
	advance(30 * time.Second)
	if code, out := submit(tok, "Ben", 100, 5, 100_000); code != http.StatusForbidden {
		t.Fatalf("claimed 100s after 30s of real time: %d %v", code, out)
	}

	tok = start()
	advance(5 * time.Minute)
	for _, bad := range []struct {
		score, wave int
		ms          int64
		field       string
	}{
		{99_999, 5, 100_000, "score"},  // more than 2000/wave
		{100, 0, 100_000, "wave"},      // no waves
		{100, 51, 250_000, "wave"},     // beyond max wave
		{100, 10, 1_000, "durationMs"}, // 10 waves in 1s
		{-5, 1, 10_000, "score"},       // negative
	} {
		code, out := submit(tok, "Cara", bad.score, bad.wave, bad.ms)
		if code != 422 || out["field"] != bad.field {
			t.Fatalf("%+v: %d %v", bad, code, out)
		}
	}
	if code, out := submit(tok, "f.u.c.k", 100, 1, 10_000); code != 422 || out["field"] != "name" {
		t.Fatalf("blocked name: %d %v", code, out)
	}
	code, res = submit(tok, "Cara", 9000, 5, 120_000)
	if code != 200 || res["rank"] != 1.0 {
		t.Fatalf("Cara: %d %v", code, res)
	}

	var lb struct {
		Board  string
		Scores []map[string]any
	}
	getJSON(t, ts.URL+"/api/leaderboard?board=defense", &lb)
	if len(lb.Scores) != 2 || lb.Scores[0]["name"] != "Cara" || lb.Scores[1]["name"] != "Asha" {
		t.Fatalf("leaderboard %+v", lb)
	}
	if resp := getJSON(t, ts.URL+"/api/leaderboard?board=nope", nil); resp.StatusCode != 404 {
		t.Fatalf("unknown board %d", resp.StatusCode)
	}
}

func TestScoreRateLimit(t *testing.T) {
	ts, _ := newTestServer(t, nil)
	codes := map[int]int{}
	for i := 0; i < 5; i++ {
		resp, _ := http.Post(ts.URL+"/api/leaderboard", "application/json", bytes.NewBufferString(`{}`))
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		codes[resp.StatusCode]++
	}
	if codes[429] != 2 {
		t.Fatalf("expected burst of 3 then 429s: %v", codes)
	}
}
