// Package moderation cleans and checks user-submitted text (guestbook
// messages, leaderboard names) before it is stored or shown to anyone.
package moderation

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	ErrEmpty     = errors.New("is empty")
	ErrTooLong   = errors.New("is too long")
	ErrBadUTF8   = errors.New("is not valid text")
	ErrBlocked   = errors.New("contains a word that isn't allowed")
	ErrLink      = errors.New("contains a link; links aren't allowed")
	ErrShouting  = errors.New("is mostly capital letters")
	ErrRepeating = errors.New("is mostly one repeated character")
)

// Clean normalizes free text: drops control and invisible formatting
// characters (zero-width spaces, bidi overrides), turns line breaks into
// spaces, collapses whitespace and trims. It then enforces 1..maxRunes.
func Clean(s string, maxRunes int) (string, error) {
	if !utf8.ValidString(s) {
		return "", ErrBadUTF8
	}
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			space = true
			continue
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r), r == utf8.RuneError:
			continue // invisible tricks: ZWSP, RLO, BOM...
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	out := b.String()
	n := utf8.RuneCountInString(out)
	if n == 0 {
		return "", ErrEmpty
	}
	if n > maxRunes {
		return "", ErrTooLong
	}
	return out, nil
}

// Check rejects blocked words, links and low-effort spam.
func Check(s string) error {
	if hasLink(s) {
		return ErrLink
	}
	if containsBlocked(s) {
		return ErrBlocked
	}
	letters, upper := 0, 0
	counts := map[rune]int{}
	total := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
		if !unicode.IsSpace(r) {
			counts[unicode.ToLower(r)]++
			total++
		}
	}
	if letters >= 12 && upper*10 > letters*8 {
		return ErrShouting
	}
	if total >= 8 {
		for _, c := range counts {
			if c*10 > total*8 {
				return ErrRepeating
			}
		}
	}
	return nil
}

func hasLink(s string) bool {
	l := strings.ToLower(s)
	if strings.Contains(l, "://") || strings.Contains(l, "www.") {
		return true
	}
	// bare domains like "cheap-pills.com" or "t.me/x"
	for _, tld := range []string{".com", ".net", ".org", ".io", ".xyz", ".ru", ".in/", ".ly", ".me/", ".gg/", ".co/"} {
		if i := strings.Index(l, tld); i > 0 && isWordRune(rune(l[i-1])) {
			end := i + len(tld)
			if strings.HasSuffix(tld, "/") || end >= len(l) || !unicode.IsLetter(rune(l[end])) {
				return true
			}
		}
	}
	return false
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' }

var leet = map[rune]rune{'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i'}

// tokens lowercases, undoes common leetspeak and splits into letter runs.
// Separators inside a word ("f.u.c.k", "f u c k") are handled by also
// joining runs of single-letter tokens.
func tokens(s string) []string {
	var out []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			out = append(out, string(cur))
			cur = cur[:0]
		}
	}
	for _, r := range strings.ToLower(s) {
		if m, ok := leet[r]; ok {
			r = m
		}
		if unicode.IsLetter(r) {
			cur = append(cur, r)
		} else {
			flush()
		}
	}
	flush()
	// join consecutive single letters: "f u c k" -> "fuck"
	var joined []string
	var run strings.Builder
	for _, t := range out {
		if utf8.RuneCountInString(t) == 1 {
			run.WriteString(t)
			continue
		}
		if run.Len() > 1 {
			joined = append(joined, run.String())
		}
		run.Reset()
	}
	if run.Len() > 1 {
		joined = append(joined, run.String())
	}
	return append(out, joined...)
}

// squeeze collapses repeated letters: "fuuuuck" -> "fuck".
func squeeze(s string) string {
	var b strings.Builder
	var prev rune
	for i, r := range s {
		if i == 0 || r != prev {
			b.WriteRune(r)
		}
		prev = r
	}
	return b.String()
}

var (
	exact    = map[string]bool{} // whole-token matches
	squeezed = map[string]bool{} // matches after squeezing repeats (only terms that stay ≥4 letters)
	long     []string            // 7+ letter terms, also matched inside the letters-only text
)

func init() {
	for _, w := range blockedWords {
		exact[w] = true
		if sq := squeeze(w); utf8.RuneCountInString(sq) >= 4 {
			squeezed[sq] = true
		}
		// 7+ letters: short enough terms ("rapist" in "therapist") hide
		// inside ordinary words, so they only match as whole tokens.
		if utf8.RuneCountInString(w) >= 7 {
			long = append(long, w)
		}
	}
}

func containsBlocked(s string) bool {
	var letters strings.Builder
	for _, t := range tokens(s) {
		if exact[t] || squeezed[squeeze(t)] {
			return true
		}
		letters.WriteString(t)
	}
	// Long terms are distinctive enough to match inside other text
	// ("xxmotherfuckerxx") without hitting innocent words.
	all := letters.String()
	sq := squeeze(all)
	for _, w := range long {
		if strings.Contains(all, w) || strings.Contains(sq, squeeze(w)) {
			return true
		}
	}
	return false
}
