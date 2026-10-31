package moderation

import (
	"errors"
	"strings"
	"testing"
)

func TestClean(t *testing.T) {
	cases := []struct {
		in, want string
		max      int
		err      error
	}{
		{"  hello   world  ", "hello world", 40, nil},
		{"line1\nline2\r\n\tline3", "line1 line2 line3", 40, nil},
		{"zero\u200bwidth", "zerowidth", 40, nil},
		{"evil\u202Etxt", "eviltxt", 40, nil}, // right-to-left override removed
		{"bell\x07", "bell", 40, nil},
		{"   ", "", 40, ErrEmpty},
		{"\u200b\u200b", "", 40, ErrEmpty},
		{strings.Repeat("a", 11), "", 10, ErrTooLong},
		{"नमस्ते दुनिया", "नमस्ते दुनिया", 13, nil}, // limit counts runes, not bytes
		{"\xff\xfe", "", 40, ErrBadUTF8},
	}
	for _, c := range cases {
		got, err := Clean(c.in, c.max)
		if !errors.Is(err, c.err) || got != c.want {
			t.Errorf("Clean(%q) = %q, %v; want %q, %v", c.in, got, err, c.want, c.err)
		}
	}
}

func TestBlockedWords(t *testing.T) {
	blocked := []string{
		"fuck this", "FUCK", "f u c k", "f.u.c.k off", "fuuuuuck", "fuck you",
		"sh1t happens", "what a b1tch", "you $lut", "a55hole", "xxmotherfuckerxx",
		"tu chutiya hai", "BHENCHOD", "bhenchoddd", "madarchod bro", "bsdk",
	}
	for _, s := range blocked {
		if err := Check(s); !errors.Is(err, ErrBlocked) {
			t.Errorf("Check(%q) = %v, want ErrBlocked", s, err)
		}
	}
}

func TestInnocentWordsPass(t *testing.T) {
	// The Scunthorpe problem: these contain blocked substrings.
	ok := []string{
		"Great class, I passed!", "Scunthorpe United", "cocktail party", "Dickens fan",
		"assessment ready", "shiitake mushrooms", "grape juice", "Therapist here",
		"Analyst in Essex", "Hello from Prayagraj!", "Nice Go backend, as expected",
		"Bass player", "Mr Hancock", "classic", "Thanks Yashasvi, the queue station is neat",
		"bachchon ke liye", "lundgren", "Pushkin", "Saturday", "skyscraper",
	}
	for _, s := range ok {
		if err := Check(s); err != nil {
			t.Errorf("Check(%q) = %v, want nil", s, err)
		}
	}
}

func TestLinksAndSpam(t *testing.T) {
	cases := map[string]error{
		"visit https://spam.example":         ErrLink,
		"www.buy-now.biz":                    ErrLink,
		"cheap-pills.com today":              ErrLink,
		"join t.me/spamchannel":              ErrLink,
		"I like Node.js and Go":              nil,
		"e.g. this, i.e. that":               nil,
		"HELLO EVERYONE THIS IS GREAT":       ErrShouting,
		"Hi NASA":                            nil,
		"aaaaaaaaaaaaaaa":                    ErrRepeating,
		"!!!!!!!!!!!!!!!!":                   ErrRepeating,
		"Loved the packets ❤️❤️":             nil,
		"The .com bubble was before my time": nil,
	}
	for in, want := range cases {
		if err := Check(in); !errors.Is(err, want) {
			t.Errorf("Check(%q) = %v, want %v", in, err, want)
		}
	}
}
