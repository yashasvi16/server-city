// Package store persists the guestbook and leaderboards.
//
// Store is the interface handlers depend on, so a SQLite or Postgres
// implementation can replace the file store without touching the API.
package store

import (
	"context"
	"errors"
	"time"
)

// Entry is one guestbook message.
type Entry struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

// Score is a player's best result on one leaderboard.
type Score struct {
	Board      string    `json:"board"`
	Name       string    `json:"name"`
	Score      int       `json:"score"`
	Wave       int       `json:"wave"`
	DurationMs int64     `json:"durationMs"`
	At         time.Time `json:"at"`
}

// SubmitResult reports where a submission landed.
type SubmitResult struct {
	// Rank is 1-based on the board after this submission (0 if the player's
	// best didn't make the retained top list).
	Rank int `json:"rank"`
	// Improved is true when this beat the player's previous best.
	Improved bool `json:"improved"`
	// Best is the player's best score on this board now.
	Best int `json:"best"`
}

var ErrClosed = errors.New("store: closed")

// Store is the persistence contract for the site.
type Store interface {
	// AddEntry appends a guestbook entry. ID and At must be set by the caller.
	AddEntry(ctx context.Context, e Entry) error
	// Entries returns up to limit newest-first entries.
	Entries(ctx context.Context, limit int) ([]Entry, error)
	// RecentlyPosted reports whether an identical message was posted recently
	// (cheap duplicate-spam check).
	RecentlyPosted(ctx context.Context, message string, within int) (bool, error)

	// SubmitScore keeps the best score per (board, name, case-insensitive).
	SubmitScore(ctx context.Context, s Score) (SubmitResult, error)
	// Top returns up to limit best scores on a board, highest first.
	Top(ctx context.Context, board string, limit int) ([]Score, error)

	Close() error
}
