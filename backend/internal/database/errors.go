package database

import (
	"context"
	"errors"
	"net"

	"github.com/jackc/pgx/v5/pgconn"
)

// FailureCode classifies internal causes without exposing SQL, URLs, or server messages.
func FailureCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) {
		switch postgres.Code {
		case "28P01", "28000":
			return "authentication_failed"
		case "42501":
			return "permission_denied"
		case "3D000":
			return "database_missing"
		case "2BP01":
			return "schema_not_empty"
		case "42P06":
			return "schema_exists"
		case "55P03":
			return "lock_timeout"
		case "57014":
			return "statement_canceled"
		default:
			return "statement_failed"
		}
	}
	var network net.Error
	if errors.As(err, &network) {
		return "connection_failed"
	}
	return "database_failed"
}
