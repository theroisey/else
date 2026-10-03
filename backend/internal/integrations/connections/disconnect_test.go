package connections

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestDisconnectStrictBodyAndSafeErrors(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `{}`, `{"revision":"1"}`, `{"revision":"1","confirmed":false}`, `{"revision":"1","confirmed":null}`, `{"revision":1,"confirmed":true}`, `{"revision":"01","confirmed":true}`, `{"revision":"+1","confirmed":true}`, `{"revision":"0","confirmed":true}`, `{"revision":"9223372036854775808","confirmed":true}`, `{"revision":"1","confirmed":true,"actor_id":"forged"}`, `{"Revision":"1","confirmed":true}`, `{"revision":"1","confirmed":true,"confirmed":true}`, `{"revision":"1","revision":"2","confirmed":true}`, `{"revision":"1","confirmed":true} {}`, `{"revision":"1","confirmed":true`} {
		if _, e := decodeDisconnect(strings.NewReader(body)); e != ErrInvalid {
			t.Fatal("ambiguous/invalid command accepted")
		}
	}
	for _, revision := range []string{"1", "9223372036854775807"} {
		body := fmt.Sprintf(`{"confirmed":true,"revision":%q}`, revision)
		if got, e := decodeDisconnect(strings.NewReader(body)); e != nil || got != revision {
			t.Fatal("canonical int64 request rejected", e)
		}
	}
	for code, want := range map[string]error{"P0002": ErrMissing, "P0003": ErrConflict, "22023": ErrInvalid, "40001": ErrUnavailable} {
		e := disconnectError(fmt.Errorf("private: %w", &pgconn.PgError{Code: code, Message: "synthetic-private-token", Detail: "synthetic-private-token"}))
		if e != want || strings.Contains(fmt.Sprint(e), "synthetic-private-token") || errors.Unwrap(e) != nil {
			t.Fatal("private database cause escaped")
		}
	}
	if _, e := (&Service{}).Disconnect(context.Background(), "bad", "bad", "bad", "1"); e != ErrInvalid {
		t.Fatal("invalid request touched database")
	}
}
