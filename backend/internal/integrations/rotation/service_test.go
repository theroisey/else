package rotation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/vault"
)

func TestEarlyDenialAndPrivateFailures(t *testing.T) {
	if _, e := NewService(nil, nil); e != ErrInvalid {
		t.Fatal("invalid service accepted")
	}
	id := "e3000000-0000-4000-8000-000000000001"
	ctx := correlation.New(context.Background())
	s := &Service{}
	for _, c := range []struct {
		ctx                  context.Context
		actor, client, after string
		limit                int
	}{
		{nil, id, id, "", 1}, {context.Background(), id, id, "", 1}, {ctx, "", id, "", 1},
		{ctx, id, strings.ToUpper(id), "", 1}, {ctx, id, id, "00000000-0000-0000-0000-000000000000", 1},
		{ctx, id, id, "bad", 1}, {ctx, id, id, "", 0}, {ctx, id, id, "", 101},
	} {
		if r, e := s.Run(c.ctx, c.actor, c.client, c.after, c.limit); e != ErrInvalid || r != (Result{}) {
			t.Fatal("invalid request touched execution")
		}
	}
	for _, c := range []struct{ err, want error }{
		{vault.ErrMissing, ErrMissing}, {vault.ErrConflict, ErrConflict}, {vault.ErrExhausted, ErrExhausted},
		{&pgconn.PgError{Code: "P0002", Message: "synthetic-private-database"}, ErrMissing},
		{&pgconn.PgError{Code: "22023", Message: "synthetic-private-key"}, ErrInvalid},
		{&pgconn.PgError{Code: "40001", Message: "synthetic-private-commit"}, ErrUnavailable},
	} {
		e := safeError(fmt.Errorf("synthetic-private: %w", c.err))
		if e != c.want || errors.Unwrap(e) != nil || strings.Contains(e.Error(), "synthetic-private") {
			t.Fatal("private failure escaped")
		}
	}
}

func TestKnownProgressLookaheadAndStopWithoutRetry(t *testing.T) {
	items := []candidate{{"first", vault.Checkpoint{ConnectionRevision: 3, Generation: 2, CredentialRevision: 1}}, {"second", vault.Checkpoint{ConnectionRevision: 6, Generation: 4, CredentialRevision: 2}}, {"lookahead", vault.Checkpoint{ConnectionRevision: 9, Generation: 5, CredentialRevision: 3}}}
	for _, failure := range []error{nil, vault.ErrConflict, vault.ErrMissing, vault.ErrExhausted, vault.ErrUnavailable} {
		calls := 0
		s := &Service{rewrap: func(ctx context.Context, actor, client, connection string, c vault.Checkpoint) (vault.Checkpoint, error) {
			if actor != "actor" || client != "client" || connection != items[calls].connection || c != items[calls].checkpoint {
				t.Fatal("batch changed selected identity/checkpoint")
			}
			calls++
			if calls == 2 && failure != nil {
				return vault.Checkpoint{}, failure
			}
			return vault.Checkpoint{ConnectionRevision: c.ConnectionRevision + 1, Generation: c.Generation, CredentialRevision: c.CredentialRevision + 1}, nil
		}}
		r, e := s.apply(context.Background(), "actor", "client", "previous", 2, items)
		if calls != 2 || !r.More {
			t.Fatal("lookahead was written or retry occurred")
		}
		if failure == nil {
			if e != nil || r != (Result{Rewrapped: 2, ResumeAfter: "second", PageComplete: true, More: true}) {
				t.Fatal("complete bounded page lost progress")
			}
		} else if e != safeError(failure) || r != (Result{Rewrapped: 1, ResumeAfter: "first", Pending: "second", More: true}) {
			t.Fatal("failed/uncertain row advanced progress")
		}
	}
}

func TestCancellationKeepsKnownCommitAndEmptyPageFlags(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{rewrap: func(context.Context, string, string, string, vault.Checkpoint) (vault.Checkpoint, error) {
		cancel()
		return vault.Checkpoint{}, nil
	}}
	r, e := s.apply(ctx, "actor", "client", "", 2, []candidate{{connection: "first"}, {connection: "second"}})
	if e != ErrUnavailable || r != (Result{Rewrapped: 1, ResumeAfter: "first", Pending: "second"}) {
		t.Fatal("cancellation lost known commit or advanced cursor")
	}
	if r, e := s.apply(context.Background(), "actor", "client", "previous", 2, nil); e != nil || r != (Result{ResumeAfter: "previous", PageComplete: true}) {
		t.Fatal("empty eligible page fabricated work")
	}
	if r, e := s.apply(ctx, "actor", "client", "previous", 2, nil); e != ErrUnavailable || r.PageComplete {
		t.Fatal("cancelled empty page reported completion")
	}
}
