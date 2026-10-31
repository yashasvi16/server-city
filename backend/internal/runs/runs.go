// Package runs issues signed, single-use game-run tokens.
//
// The client asks for a token when a game starts and sends it back with the
// score. The server checks the HMAC signature, that the token is unused and
// fresh, and that the claimed play time fits inside the real time since the
// token was issued. This doesn't make a browser game cheat-proof (the client
// still computes the score), but it stops replayed or hand-crafted
// submissions, and caps how fast a run can claim to have been.
package runs

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalid = errors.New("run token is invalid")
	ErrExpired = errors.New("run token has expired")
	ErrUsed    = errors.New("run token was already used")
	ErrTooLong = errors.New("claimed play time is longer than the run")
)

// Issuer signs and redeems tokens. Safe for concurrent use.
type Issuer struct {
	key   []byte
	ttl   time.Duration
	slack time.Duration
	now   func() time.Time

	mu   sync.Mutex
	used map[string]time.Time // token id -> expiry
}

// New creates an issuer. An empty secret generates a random one, so tokens
// don't survive a restart (fine: a run lasts minutes).
func New(secret string, ttl time.Duration) *Issuer {
	key := []byte(secret)
	if len(key) == 0 {
		key = make([]byte, 32)
		_, _ = rand.Read(key)
	}
	return &Issuer{key: key, ttl: ttl, slack: 3 * time.Second, now: time.Now, used: map[string]time.Time{}}
}

// SetClock replaces the time source (tests).
func (i *Issuer) SetClock(now func() time.Time) { i.now = now }

// payload: 8 bytes issued-at (unix ms) | 12 bytes random id | board
func (i *Issuer) sign(p []byte) []byte {
	m := hmac.New(sha256.New, i.key)
	m.Write(p)
	return m.Sum(nil)[:16]
}

// Issue returns a token for one run on board.
func (i *Issuer) Issue(board string) (string, time.Time) {
	now := i.now()
	p := make([]byte, 20, 20+len(board))
	binary.BigEndian.PutUint64(p, uint64(now.UnixMilli()))
	_, _ = rand.Read(p[8:20])
	p = append(p, board...)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(p) + "." + enc.EncodeToString(i.sign(p)), now
}

// Redeem validates and consumes a token for board with the claimed play
// time.
func (i *Issuer) Redeem(token, board string, claimed time.Duration) error {
	enc := base64.RawURLEncoding
	ps, ss, ok := strings.Cut(token, ".")
	if !ok || len(token) > 256 {
		return ErrInvalid
	}
	p, err1 := enc.DecodeString(ps)
	sig, err2 := enc.DecodeString(ss)
	if err1 != nil || err2 != nil || len(p) < 20 || !hmac.Equal(sig, i.sign(p)) {
		return ErrInvalid
	}
	if string(p[20:]) != board {
		return ErrInvalid
	}
	issued := time.UnixMilli(int64(binary.BigEndian.Uint64(p)))
	now := i.now()
	if now.Sub(issued) > i.ttl || issued.After(now.Add(i.slack)) {
		return ErrExpired
	}
	if claimed > now.Sub(issued)+i.slack {
		return ErrTooLong
	}
	id := string(p[8:20])
	i.mu.Lock()
	defer i.mu.Unlock()
	for k, exp := range i.used { // tiny map: only live tokens are kept
		if now.After(exp) {
			delete(i.used, k)
		}
	}
	if _, dup := i.used[id]; dup {
		return ErrUsed
	}
	i.used[id] = issued.Add(i.ttl)
	return nil
}
