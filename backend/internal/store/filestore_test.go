package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

var ctx = context.Background()

func open(t *testing.T, dir string, opt Options) *FileStore {
	t.Helper()
	opt.NoSync = true
	s, err := OpenFile(dir, opt, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func entry(i int) Entry {
	return Entry{ID: fmt.Sprint(i), Name: "n", Message: fmt.Sprintf("msg %d", i), At: time.Unix(int64(1000+i), 0).UTC()}
}

func TestPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	for i := 0; i < 3; i++ {
		if err := s.AddEntry(ctx, entry(i)); err != nil {
			t.Fatal(err)
		}
	}
	s.SubmitScore(ctx, Score{Board: "defense", Name: "Asha", Score: 50, Wave: 3})
	s.Close()

	s2 := open(t, dir, Options{})
	defer s2.Close()
	es, _ := s2.Entries(ctx, 10)
	if len(es) != 3 || es[0].Message != "msg 2" || !es[0].At.Equal(entry(2).At) {
		t.Fatalf("entries after reopen: %+v", es)
	}
	top, _ := s2.Top(ctx, "defense", 10)
	if len(top) != 1 || top[0].Score != 50 {
		t.Fatalf("scores after reopen: %+v", top)
	}
}

func TestTornTailIsTruncatedAndAppendsStayValid(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	s.AddEntry(ctx, entry(1))
	s.Close()
	// Simulate a crash mid-write: half a JSON line with no newline.
	f, _ := os.OpenFile(filepath.Join(dir, "site.log"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"k":"e","e":{"id":"2","na`)
	f.Close()

	s2 := open(t, dir, Options{})
	if es, _ := s2.Entries(ctx, 10); len(es) != 1 {
		t.Fatalf("want 1 entry after torn tail, got %d", len(es))
	}
	s2.AddEntry(ctx, entry(3))
	s2.Close()

	s3 := open(t, dir, Options{})
	defer s3.Close()
	es, _ := s3.Entries(ctx, 10)
	if len(es) != 2 || es[0].ID != "3" {
		t.Fatalf("append after truncation broke the log: %+v", es)
	}
}

func TestCorruptMiddleLineSkipped(t *testing.T) {
	dir := t.TempDir()
	content := `{"k":"e","e":{"id":"1","name":"a","message":"one","at":"2026-01-01T00:00:00Z"}}
this is not json
{"k":"x"}
{"k":"e","e":{"id":"2","name":"b","message":"two","at":"2026-01-01T00:00:01Z"}}
`
	os.WriteFile(filepath.Join(dir, "site.log"), []byte(content), 0o640)
	s := open(t, dir, Options{})
	defer s.Close()
	if es, _ := s.Entries(ctx, 10); len(es) != 2 {
		t.Fatalf("want 2 valid entries, got %d", len(es))
	}
}

func TestBestScorePerNameAndRank(t *testing.T) {
	s := open(t, "", Options{})
	sub := func(name string, score, wave int) SubmitResult {
		r, err := s.SubmitScore(ctx, Score{Board: "defense", Name: name, Score: score, Wave: wave})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := sub("Asha", 100, 5); r.Rank != 1 || !r.Improved {
		t.Fatalf("first: %+v", r)
	}
	if r := sub("Ben", 200, 6); r.Rank != 1 {
		t.Fatalf("ben: %+v", r)
	}
	if r := sub("asha", 90, 9); r.Improved || r.Best != 100 || r.Rank != 2 {
		t.Fatalf("lower score must not replace best (case-insensitive name): %+v", r)
	}
	if r := sub("ASHA", 300, 7); !r.Improved || r.Rank != 1 {
		t.Fatalf("improvement: %+v", r)
	}
	top, _ := s.Top(ctx, "defense", 10)
	if len(top) != 2 || top[0].Name != "ASHA" || top[1].Name != "Ben" {
		t.Fatalf("top: %+v", top)
	}
	if other, _ := s.Top(ctx, "other", 10); len(other) != 0 {
		t.Fatal("boards must be separate")
	}
}

func TestTieBreaks(t *testing.T) {
	s := open(t, "", Options{})
	t0 := time.Unix(100, 0)
	s.SubmitScore(ctx, Score{Board: "b", Name: "slow", Score: 10, Wave: 2, DurationMs: 9000, At: t0})
	s.SubmitScore(ctx, Score{Board: "b", Name: "fast", Score: 10, Wave: 2, DurationMs: 5000, At: t0.Add(time.Hour)})
	s.SubmitScore(ctx, Score{Board: "b", Name: "deep", Score: 10, Wave: 3, DurationMs: 99000, At: t0.Add(2 * time.Hour)})
	top, _ := s.Top(ctx, "b", 10)
	got := []string{top[0].Name, top[1].Name, top[2].Name}
	if fmt.Sprint(got) != "[deep fast slow]" {
		t.Fatalf("order %v", got)
	}
}

func TestRetentionLimits(t *testing.T) {
	s := open(t, "", Options{MaxEntries: 3, MaxPerBoard: 2})
	for i := 0; i < 5; i++ {
		s.AddEntry(ctx, entry(i))
		s.SubmitScore(ctx, Score{Board: "b", Name: fmt.Sprint(i), Score: i})
	}
	es, _ := s.Entries(ctx, 10)
	if len(es) != 3 || es[2].ID != "2" {
		t.Fatalf("entries %+v", es)
	}
	top, _ := s.Top(ctx, "b", 10)
	if len(top) != 2 || top[0].Score != 4 || top[1].Score != 3 {
		t.Fatalf("top %+v", top)
	}
}

func TestCompactionShrinksLogAndKeepsData(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{MaxEntries: 10})
	for i := 0; i < 600; i++ {
		s.AddEntry(ctx, entry(i))
		s.SubmitScore(ctx, Score{Board: "b", Name: "same", Score: i}) // each one supersedes the last
	}
	s.Close()
	fi, _ := os.Stat(filepath.Join(dir, "site.log"))
	if fi.Size() > 100_000 {
		t.Fatalf("log not compacted: %d bytes", fi.Size())
	}
	if _, err := os.Stat(filepath.Join(dir, "site.log.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
	s2 := open(t, dir, Options{MaxEntries: 10})
	defer s2.Close()
	es, _ := s2.Entries(ctx, 100)
	top, _ := s2.Top(ctx, "b", 10)
	if len(es) != 10 || es[0].ID != "599" || len(top) != 1 || top[0].Score != 599 {
		t.Fatalf("data lost in compaction: %d entries, top %+v", len(es), top)
	}
}

func TestRecentlyPosted(t *testing.T) {
	s := open(t, "", Options{})
	s.AddEntry(ctx, Entry{ID: "1", Message: "Hello there"})
	for i := 0; i < 5; i++ {
		s.AddEntry(ctx, entry(i))
	}
	if ok, _ := s.RecentlyPosted(ctx, "hello THERE", 10); !ok {
		t.Error("duplicate within window not found")
	}
	if ok, _ := s.RecentlyPosted(ctx, "hello there", 3); ok {
		t.Error("duplicate outside window should not count")
	}
}

func TestConcurrentWritersAndReaders(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				s.AddEntry(ctx, Entry{ID: fmt.Sprintf("%d-%d", g, i), Message: "x"})
				s.SubmitScore(ctx, Score{Board: "b", Name: fmt.Sprint(g), Score: i})
				s.Entries(ctx, 5)
				s.Top(ctx, "b", 5)
			}
		}(g)
	}
	wg.Wait()
	s.Close()
	s2 := open(t, dir, Options{})
	defer s2.Close()
	es, _ := s2.Entries(ctx, 1000)
	top, _ := s2.Top(ctx, "b", 100)
	if len(es) != 400 || len(top) != 8 || top[0].Score != 49 {
		t.Fatalf("after concurrent writes: %d entries, %d scores", len(es), len(top))
	}
}

func TestClosed(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	s.Close()
	if err := s.AddEntry(ctx, entry(1)); err != ErrClosed {
		t.Fatalf("want ErrClosed, got %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal("double close should be fine")
	}
}
