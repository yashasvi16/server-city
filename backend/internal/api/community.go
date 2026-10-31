package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/yashasvi16/server-city/backend/internal/moderation"
	"github.com/yashasvi16/server-city/backend/internal/runs"
	"github.com/yashasvi16/server-city/backend/internal/store"
)

// Limits for user-submitted content.
const (
	MaxNameRunes    = 24
	MaxMessageRunes = 280
	maxBodyBytes    = 4 << 10
	dupWindow       = 50 // reject a message identical to one of the last N
)

// BoardRules bounds what a plausible score looks like on a leaderboard, so a
// submission that couldn't come from a real game is rejected even with a
// valid run token. The tower-defense game must stay inside these.
type BoardRules struct {
	MaxWave         int
	MaxScorePerWave int
	MinMsPerWave    int64
	MaxDuration     time.Duration
}

// Boards lists the leaderboards that accept scores.
var Boards = map[string]BoardRules{
	"defense": {MaxWave: 50, MaxScorePerWave: 2000, MinMsPerWave: 4000, MaxDuration: 2 * time.Hour},
}

type apiError struct {
	Error string `json:"error"`
	Field string `json:"field,omitempty"`
}

func fail(w http.ResponseWriter, status int, field, msg string) {
	writeJSON(w, status, apiError{Error: msg, Field: field})
}

// decodeJSON enforces content type, body size and a strict schema. Requiring
// application/json also means a plain cross-site HTML form can't post here:
// browsers must preflight it, and CORS only allows configured origins.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "", "send JSON with Content-Type: application/json")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			fail(w, http.StatusRequestEntityTooLarge, "", "request body is too large")
		} else {
			fail(w, http.StatusBadRequest, "", "request body is not valid JSON for this endpoint")
		}
		return false
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		fail(w, http.StatusBadRequest, "", "send exactly one JSON object")
		return false
	}
	return true
}

// writeAllowed applies a stricter per-IP limit to write endpoints.
func (s *Server) writeAllowed(w http.ResponseWriter, r *http.Request, l interface {
	Allow(string) (bool, time.Duration)
}, what string) bool {
	ok, retry := l.Allow(ClientIP(r, s.cfg.ClientIPHeader))
	if !ok {
		secs := max(1, int(retry.Seconds()+0.999))
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		fail(w, http.StatusTooManyRequests, "", "you're "+what+" too often; try again in "+strconv.Itoa(secs)+"s")
	}
	return ok
}

func queryLimit(r *http.Request, def, hi int) int {
	n, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || n < 1 {
		return def
	}
	return min(n, hi)
}

// cleanField runs Clean + Check and reports a field-specific message.
func cleanField(w http.ResponseWriter, field, label, v string, maxRunes int) (string, bool) {
	out, err := moderation.Clean(v, maxRunes)
	if err == nil {
		err = moderation.Check(out)
	}
	if err != nil {
		msg := label + " " + err.Error()
		if errors.Is(err, moderation.ErrTooLong) {
			msg = label + " can be at most " + strconv.Itoa(maxRunes) + " characters"
		}
		fail(w, http.StatusUnprocessableEntity, field, msg)
		return "", false
	}
	return out, true
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ---- guestbook --------------------------------------------------------------

func (s *Server) handleGuestbookList(w http.ResponseWriter, r *http.Request) {
	es, err := s.store.Entries(r.Context(), queryLimit(r, 30, 100))
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "", "the guestbook is unavailable right now")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"entries": es})
}

func (s *Server) handleGuestbookPost(w http.ResponseWriter, r *http.Request) {
	if !s.writeAllowed(w, r, s.guestbookLimiter, "signing the guestbook") {
		return
	}
	var in struct {
		Name    string `json:"name"`
		Message string `json:"message"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	name := "Anonymous visitor"
	if in.Name != "" {
		var ok bool
		if name, ok = cleanField(w, "name", "Name", in.Name, MaxNameRunes); !ok {
			return
		}
	}
	msg, ok := cleanField(w, "message", "Message", in.Message, MaxMessageRunes)
	if !ok {
		return
	}
	if dup, _ := s.store.RecentlyPosted(r.Context(), msg, dupWindow); dup {
		fail(w, http.StatusConflict, "message", "That exact message was just posted. Try saying something new.")
		return
	}
	e := store.Entry{ID: newID(), Name: name, Message: msg, At: time.Now().UTC().Truncate(time.Second)}
	if err := s.store.AddEntry(r.Context(), e); err != nil {
		s.log.Error("guestbook write failed", "err", err)
		fail(w, http.StatusServiceUnavailable, "", "couldn't save your message; please try again")
		return
	}
	s.log.Info("guestbook entry", "id", e.ID, "ip", ClientIP(r, s.cfg.ClientIPHeader))
	if raw, err := json.Marshal(map[string]any{"t": "gb", "e": e}); err == nil {
		s.hub.Broadcast(raw) // live update for everyone in the city
	}
	writeJSON(w, http.StatusCreated, e)
}

// ---- leaderboard ------------------------------------------------------------

func (s *Server) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	board := r.URL.Query().Get("board")
	if _, ok := Boards[board]; !ok {
		fail(w, http.StatusNotFound, "board", "no leaderboard called "+strconv.Quote(board))
		return
	}
	top, err := s.store.Top(r.Context(), board, queryLimit(r, 20, 100))
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "", "the leaderboard is unavailable right now")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"board": board, "scores": top})
}

func (s *Server) handleRunStart(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Board string `json:"board"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := Boards[in.Board]; !ok {
		fail(w, http.StatusNotFound, "board", "no leaderboard called "+strconv.Quote(in.Board))
		return
	}
	tok, at := s.runs.Issue(in.Board)
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "board": in.Board, "issuedAt": at.UTC()})
}

func (s *Server) handleScorePost(w http.ResponseWriter, r *http.Request) {
	if !s.writeAllowed(w, r, s.scoreLimiter, "submitting scores") {
		return
	}
	var in struct {
		Board      string `json:"board"`
		Name       string `json:"name"`
		Score      int    `json:"score"`
		Wave       int    `json:"wave"`
		DurationMs int64  `json:"durationMs"`
		Token      string `json:"token"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	rules, ok := Boards[in.Board]
	if !ok {
		fail(w, http.StatusNotFound, "board", "no leaderboard called "+strconv.Quote(in.Board))
		return
	}
	name, ok := cleanField(w, "name", "Name", in.Name, MaxNameRunes)
	if !ok {
		return
	}
	switch {
	case in.Wave < 1 || in.Wave > rules.MaxWave:
		fail(w, http.StatusUnprocessableEntity, "wave", "wave is out of range")
		return
	case in.Score < 0 || in.Score > in.Wave*rules.MaxScorePerWave:
		fail(w, http.StatusUnprocessableEntity, "score", "score isn't possible for that many waves")
		return
	case in.DurationMs < int64(in.Wave)*rules.MinMsPerWave || in.DurationMs > rules.MaxDuration.Milliseconds():
		fail(w, http.StatusUnprocessableEntity, "durationMs", "play time isn't possible for that many waves")
		return
	}
	if err := s.runs.Redeem(in.Token, in.Board, time.Duration(in.DurationMs)*time.Millisecond); err != nil {
		status := http.StatusForbidden
		if errors.Is(err, runs.ErrUsed) {
			status = http.StatusConflict
		}
		fail(w, status, "token", err.Error())
		return
	}
	res, err := s.store.SubmitScore(r.Context(), store.Score{
		Board: in.Board, Name: name, Score: in.Score, Wave: in.Wave,
		DurationMs: in.DurationMs, At: time.Now().UTC().Truncate(time.Second),
	})
	if err != nil {
		s.log.Error("score write failed", "err", err)
		fail(w, http.StatusServiceUnavailable, "", "couldn't save your score; please try again")
		return
	}
	if res.Improved {
		if raw, err := json.Marshal(map[string]any{"t": "lb", "board": in.Board}); err == nil {
			s.hub.Broadcast(raw)
		}
	}
	writeJSON(w, http.StatusOK, res)
}
