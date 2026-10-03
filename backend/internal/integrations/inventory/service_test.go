package inventory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/correlation"
)

func TestInvalidRequestsStopBeforeDatabaseAccess(t *testing.T) {
	for _, pool := range []*pgxpool.Pool{nil, {}} {
		if service, err := NewService(pool, nil); service != nil || err != ErrInvalid {
			t.Fatal("invalid service accepted")
		}
	}
	id := "e3000000-0000-4000-8000-000000000001"
	ctx := correlation.New(context.Background())
	for _, request := range []struct {
		ctx   context.Context
		actor string
	}{
		{nil, id}, {context.Background(), id}, {ctx, ""}, {ctx, "private-value"},
		{ctx, strings.ToUpper(id)}, {ctx, "00000000-0000-0000-0000-000000000000"},
	} {
		if rows, err := (&Service{}).Observe(request.ctx, request.actor, false); rows != nil || err != ErrInvalid {
			t.Fatal("invalid request touched execution")
		}
	}
	if rows, err := (*Service)(nil).Observe(ctx, id, false); rows != nil || err != ErrInvalid {
		t.Fatal("nil service accepted")
	}
}

func TestPrivateErrorsHaveFixedClassificationWithoutCauses(t *testing.T) {
	for _, tc := range []struct {
		code string
		want error
	}{
		{"P0002", ErrMissing}, {"22023", ErrInvalid}, {"55000", ErrUnavailable},
		{"42501", ErrUnavailable}, {"57014", ErrUnavailable}, {"40001", ErrUnavailable},
	} {
		err := safeError(fmt.Errorf("private-value: %w", &pgconn.PgError{Code: tc.code, Message: "private-value"}))
		if err != tc.want || errors.Unwrap(err) != nil || strings.Contains(err.Error(), "private-value") {
			t.Fatal("private database error escaped")
		}
	}
	if safeError(errors.New("private-value")) != ErrUnavailable {
		t.Fatal("unclassified error escaped")
	}
}
