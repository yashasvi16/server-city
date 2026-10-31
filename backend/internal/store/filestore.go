package store

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// FileStore keeps all data in memory and makes it durable with an
// append-only JSON-lines log:
//
//   - Every write is appended and fsynced before it is applied in memory
//     (write-ahead), so an acknowledged write survives a crash.
//   - On open the log is replayed. A torn final line (crash mid-write) is
//     truncated away; a corrupt line in the middle is skipped and counted.
//   - When the log holds far more records than live data (old guestbook
//     entries, superseded scores), it is compacted: live state is written to
//     a temp file, fsynced, and atomically renamed over the log.
//
// It suits a single-instance site with modest write volume. Reads never
// touch disk.
type FileStore struct {
	mu   sync.RWMutex
	path string // "" = memory only (tests, demos)
	f    *os.File
	size int64 // bytes of known-good log
	sync bool
	log  *slog.Logger

	logRecords int // records in the log file since last compaction
	closed     bool

	maxEntries  int
	maxPerBoard int
	entries     []Entry                      // oldest first
	boards      map[string]map[string]*Score // board -> lower(name) -> best
}

// Options tunes retention.
type Options struct {
	MaxEntries  int  // guestbook entries retained (default 1000)
	MaxPerBoard int  // scores retained per board (default 500)
	NoSync      bool // skip fsync (tests only)
}

type record struct {
	K string `json:"k"` // "e" entry, "s" score
	E *Entry `json:"e,omitempty"`
	S *Score `json:"s,omitempty"`
}

// OpenFile opens (or creates) the store in dir. dir == "" keeps everything in
// memory.
func OpenFile(dir string, opt Options, log *slog.Logger) (*FileStore, error) {
	if opt.MaxEntries <= 0 {
		opt.MaxEntries = 1000
	}
	if opt.MaxPerBoard <= 0 {
		opt.MaxPerBoard = 500
	}
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	s := &FileStore{
		sync: !opt.NoSync, log: log,
		maxEntries: opt.MaxEntries, maxPerBoard: opt.MaxPerBoard,
		boards: map[string]map[string]*Score{},
	}
	if dir == "" {
		return s, nil
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	s.path = filepath.Join(dir, "site.log")
	f, err := os.OpenFile(s.path, os.O_RDWR|os.O_CREATE, 0o640)
	if err != nil {
		return nil, err
	}
	s.f = f
	if err := s.replay(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

func (s *FileStore) replay() error {
	r := bufio.NewReader(s.f)
	var off int64
	skipped := 0
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] != '\n' {
			// Torn write at the tail: drop it.
			s.log.Warn("store: truncating torn final record", "bytes", len(line))
			break
		}
		if len(line) > 0 {
			var rec record
			if json.Unmarshal(bytes.TrimSpace(line), &rec) != nil || !s.applyRecord(rec) {
				skipped++
			} else {
				s.logRecords++
			}
			off += int64(len(line))
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	if skipped > 0 {
		s.log.Warn("store: skipped corrupt records", "count", skipped)
	}
	if err := s.f.Truncate(off); err != nil {
		return err
	}
	if _, err := s.f.Seek(off, io.SeekStart); err != nil {
		return err
	}
	s.size = off
	s.log.Info("store: opened", "path", s.path, "records", s.logRecords,
		"entries", len(s.entries), "boards", len(s.boards))
	return nil
}

func (s *FileStore) applyRecord(r record) bool {
	switch {
	case r.K == "e" && r.E != nil:
		s.applyEntry(*r.E)
	case r.K == "s" && r.S != nil:
		s.applyScore(*r.S)
	default:
		return false
	}
	return true
}

func (s *FileStore) applyEntry(e Entry) {
	s.entries = append(s.entries, e)
	if over := len(s.entries) - s.maxEntries; over > 0 {
		s.entries = slices.Delete(s.entries, 0, over)
	}
}

// applyScore keeps a player's best, returning whether it improved.
func (s *FileStore) applyScore(sc Score) bool {
	b := s.boards[sc.Board]
	if b == nil {
		b = map[string]*Score{}
		s.boards[sc.Board] = b
	}
	key := strings.ToLower(sc.Name)
	if cur, ok := b[key]; ok && !better(sc, *cur) {
		return false
	}
	c := sc
	b[key] = &c
	if len(b) > s.maxPerBoard { // evict the worst
		var worstKey string
		var worst *Score
		for k, v := range b {
			if worst == nil || better(*worst, *v) {
				worst, worstKey = v, k
			}
		}
		delete(b, worstKey)
	}
	return true
}

// better orders scores: higher score, then further wave, then faster, then earlier.
func better(a, b Score) bool {
	if a.Score != b.Score {
		return a.Score > b.Score
	}
	if a.Wave != b.Wave {
		return a.Wave > b.Wave
	}
	if a.DurationMs != b.DurationMs {
		return a.DurationMs < b.DurationMs
	}
	return a.At.Before(b.At)
}

// appendLocked writes one record durably. Caller holds s.mu.
func (s *FileStore) appendLocked(r record) error {
	if s.closed {
		return ErrClosed
	}
	if s.f == nil {
		return nil
	}
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if _, err := s.f.Write(line); err != nil {
		// Roll back a partial write so the log stays line-aligned.
		_ = s.f.Truncate(s.size)
		_, _ = s.f.Seek(s.size, io.SeekStart)
		return fmt.Errorf("store: append: %w", err)
	}
	if s.sync {
		if err := s.f.Sync(); err != nil {
			return fmt.Errorf("store: fsync: %w", err)
		}
	}
	s.size += int64(len(line))
	s.logRecords++
	return nil
}

func (s *FileStore) liveRecords() int {
	n := len(s.entries)
	for _, b := range s.boards {
		n += len(b)
	}
	return n
}

// maybeCompactLocked rewrites the log when it is mostly dead records.
func (s *FileStore) maybeCompactLocked() {
	if s.f == nil || s.logRecords < 2*s.liveRecords()+500 {
		return
	}
	if err := s.compactLocked(); err != nil {
		s.log.Error("store: compaction failed (log still valid)", "err", err)
	}
}

func (s *FileStore) compactLocked() error {
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	n := 0
	write := func(r record) {
		if err == nil {
			err = enc.Encode(r)
			n++
		}
	}
	for i := range s.entries {
		write(record{K: "e", E: &s.entries[i]})
	}
	for _, b := range s.boards {
		for _, sc := range b {
			write(record{K: "s", S: sc})
		}
	}
	if err == nil {
		err = w.Flush()
	}
	if err == nil {
		err = f.Sync()
	}
	var size int64
	if err == nil {
		size, err = f.Seek(0, io.SeekEnd)
	}
	if err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(s.path))
	s.f.Close()
	s.f, s.size, s.logRecords = f, size, n
	s.log.Info("store: compacted", "records", n, "bytes", size)
	return nil
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

// ---- Store interface --------------------------------------------------------

func (s *FileStore) AddEntry(_ context.Context, e Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.appendLocked(record{K: "e", E: &e}); err != nil {
		return err
	}
	s.applyEntry(e)
	s.maybeCompactLocked()
	return nil
}

func (s *FileStore) Entries(_ context.Context, limit int) ([]Entry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return nil, ErrClosed
	}
	n := min(limit, len(s.entries))
	out := make([]Entry, 0, n)
	for i := len(s.entries) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, s.entries[i])
	}
	return out, nil
}

func (s *FileStore) RecentlyPosted(_ context.Context, message string, within int) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := len(s.entries) - 1; i >= 0 && i >= len(s.entries)-within; i-- {
		if strings.EqualFold(s.entries[i].Message, message) {
			return true, nil
		}
	}
	return false, nil
}

func (s *FileStore) SubmitScore(_ context.Context, sc Score) (SubmitResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return SubmitResult{}, ErrClosed
	}
	key := strings.ToLower(sc.Name)
	if cur, ok := s.boards[sc.Board][key]; ok && !better(sc, *cur) {
		// Not a new best: nothing to persist.
		return SubmitResult{Rank: s.rankLocked(*cur), Best: cur.Score}, nil
	}
	if err := s.appendLocked(record{K: "s", S: &sc}); err != nil {
		return SubmitResult{}, err
	}
	s.applyScore(sc)
	s.maybeCompactLocked()
	res := SubmitResult{Improved: true, Best: sc.Score}
	if cur, ok := s.boards[sc.Board][key]; ok {
		res.Rank = s.rankLocked(*cur)
	}
	return res, nil
}

func (s *FileStore) rankLocked(sc Score) int {
	rank := 1
	for _, o := range s.boards[sc.Board] {
		if better(*o, sc) {
			rank++
		}
	}
	return rank
}

func (s *FileStore) Top(_ context.Context, board string, limit int) ([]Score, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return nil, ErrClosed
	}
	out := make([]Score, 0, len(s.boards[board]))
	for _, v := range s.boards[board] {
		out = append(out, *v)
	}
	slices.SortFunc(out, func(a, b Score) int {
		if better(a, b) {
			return -1
		}
		if better(b, a) {
			return 1
		}
		return 0
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.f == nil {
		return nil
	}
	err := s.f.Sync()
	if cerr := s.f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Compile-time check.
var _ Store = (*FileStore)(nil)
