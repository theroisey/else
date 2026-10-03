package vault

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/budget"
)

func TestErrorsAndEarlyInputDenial(t *testing.T) {
	private := "synthetic-token-key-account-ciphertext"
	for code, want := range map[string]error{"P0002": ErrMissing, "P0003": ErrConflict, "22023": ErrInvalid, "40001": ErrUnavailable, "23505": ErrUnavailable} {
		e := safeError(fmt.Errorf("private cause: %w", &pgconn.PgError{Code: code, Message: private, Detail: private}))
		if e != want || strings.Contains(fmt.Sprint(e), private) || errors.Unwrap(e) != nil {
			t.Fatal("database error escaped safe boundary")
		}
	}
	if safeError(fmt.Errorf("%w", budget.ErrExhausted)) != ErrExhausted {
		t.Fatal("quota outcome lost")
	}
	if _, e := NewService(nil, nil); e != ErrInvalid {
		t.Fatal("invalid startup accepted")
	}
	s := &Service{} // Invalid requests must never touch a database or encrypt.
	id := "e3000000-0000-4000-8000-000000000001"
	ctx := correlation.New(context.Background())
	c := Checkpoint{1, 1, 0}
	for _, actor := range []string{"", strings.ToUpper(id), "00000000-0000-0000-0000-000000000000"} {
		if _, e := s.Inspect(ctx, actor, id, id); e != ErrInvalid {
			t.Fatal(e)
		}
		if _, e := s.Replace(ctx, actor, id, id, c, []byte("synthetic")); e != ErrInvalid {
			t.Fatal(e)
		}
		if _, e := s.Rewrap(ctx, actor, id, id, c); e != ErrInvalid {
			t.Fatal(e)
		}
	}
	if _, e := s.Replace(ctx, id, id, id, c, nil); e != ErrInvalid {
		t.Fatal(e)
	}
	if _, e := s.Replace(context.Background(), id, id, id, c, []byte("synthetic")); e != ErrInvalid {
		t.Fatal(e)
	}
	if _, e := s.Inspect(nil, id, id, id); e != ErrInvalid {
		t.Fatal(e)
	}
	if (Checkpoint{math.MaxInt64, 1, 0}).writable(false) || (Checkpoint{1, math.MaxInt64, 0}).writable(false) || (Checkpoint{1, 1, math.MaxInt64}).writable(true) {
		t.Fatal("overflow fence accepted")
	}
	if !(Checkpoint{1, math.MaxInt64, 1}).writable(true) {
		t.Fatal("rotation unnecessarily advances generation")
	}
}
