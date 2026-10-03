package budget

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

func TestErrorsDiscardDatabaseAndCredentialDetails(t *testing.T) {
	for _, spec := range []struct {
		code string
		want error
	}{{"P0002", ErrMissing}, {"P0001", ErrExhausted}, {"22023", ErrInvalid}, {"23505", ErrInvalid}, {"42501", ErrUnavailable}, {"08006", ErrUnavailable}} {
		e := safeError(&pgconn.PgError{Code: spec.code, Message: "synthetic-private-key-label", Detail: "synthetic-private-digest"})
		if e != spec.want || strings.Contains(e.Error(), "synthetic-private") {
			t.Fatal("private database error leaked")
		}
	}
	if safeError(errors.New("synthetic-private")) != ErrUnavailable || safeError(credentials.ErrOpen) != credentials.ErrOpen || safeError(audit.ErrMissingCorrelation) != ErrUnavailable {
		t.Fatal("unsafe error mapping")
	}
}

func TestInvalidRequestCannotReachAccounting(t *testing.T) {
	actor := "11111111-1111-4111-8111-111111111111"
	client := "33333333-3333-4333-8333-333333333331"
	connection := "e3000000-0000-4000-8000-000000000001"
	var service Service // A database call would panic, so rejected inputs must stop first.
	ctx := correlation.New(context.Background())
	for _, plain := range [][]byte{nil, make([]byte, credentials.MaxPlaintextBytes+1)} {
		if _, e := service.Seal(ctx, actor, client, connection, plain); e != ErrInvalid {
			t.Fatal("invalid plaintext reached accounting")
		}
	}
	for _, invalid := range []string{"", "bad", "00000000-0000-0000-0000-000000000000", strings.ToUpper(connection)} {
		if _, e := service.Seal(ctx, actor, client, invalid, []byte("synthetic")); e != ErrInvalid {
			t.Fatal("invalid identity reached accounting")
		}
	}
	for _, ctx := range []context.Context{nil, context.Background()} {
		if _, e := service.Seal(ctx, actor, client, connection, []byte("synthetic")); e != ErrInvalid {
			t.Fatal("missing correlation reached accounting")
		}
	}
	if _, e := service.Rewrap(ctx, actor, client, connection, credentials.Envelope{}); e != credentials.ErrOpen {
		t.Fatal("malformed envelope reached accounting")
	}
	if _, e := NewService(nil, nil); e != ErrInvalid {
		t.Fatal("invalid dependencies accepted")
	}
}
