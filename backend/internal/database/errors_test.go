package database

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestFailureCodesExcludeRawDiagnostics(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "deadline_exceeded"},
		{fmt.Errorf("wrapped: %w", context.Canceled), "canceled"},
		{&pgconn.PgError{Code: "28P01", Message: "secret-value"}, "authentication_failed"},
		{fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: "2BP01", Detail: "secret-value"}), "schema_not_empty"},
		{&pgconn.PgError{Code: "42501", Message: "secret-value"}, "permission_denied"},
		{&pgconn.PgError{Code: "secret-value", Message: "secret-value"}, "statement_failed"},
		{errors.New("secret-value"), "database_failed"},
	} {
		if got := FailureCode(test.err); got != test.want {
			t.Fatalf("code %s, want %s", got, test.want)
		}
	}
}
