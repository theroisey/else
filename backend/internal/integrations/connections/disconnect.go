package connections

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/theroisey/else/backend/internal/audit"
	"github.com/theroisey/else/backend/internal/correlation"
)

var ErrConflict = errors.New("integration disconnect revision conflict")
var ErrUnavailable = errors.New("integration disconnect unavailable")
var errUnchanged = errors.New("integration already locally disabled")

type Revocation struct {
	Status               string `json:"status"`
	ManualActionRequired bool   `json:"manual_action_required"`
}
type DisconnectResult struct {
	Data       Connection `json:"data"`
	Revocation Revocation `json:"revocation"`
}

func revisionNumber(raw string) (int64, error) {
	n, e := strconv.ParseInt(raw, 10, 64)
	if e != nil || n < 1 || strconv.FormatInt(n, 10) != raw {
		return 0, ErrInvalid
	}
	return n, nil
}

// decodeDisconnect accepts exact unique fields. Decoder's case-insensitive
// struct matching would otherwise accept ambiguous aliases and duplicates.
func decodeDisconnect(reader io.Reader) (string, error) {
	d := json.NewDecoder(reader)
	token, e := d.Token()
	if e != nil || token != json.Delim('{') {
		return "", ErrInvalid
	}
	seen := map[string]bool{}
	var revision string
	var confirmed bool
	for d.More() {
		token, e = d.Token()
		name, ok := token.(string)
		if e != nil || !ok || seen[name] {
			return "", ErrInvalid
		}
		seen[name] = true
		switch name {
		case "revision":
			if e = d.Decode(&revision); e != nil {
				return "", ErrInvalid
			}
		case "confirmed":
			if e = d.Decode(&confirmed); e != nil {
				return "", ErrInvalid
			}
		default:
			return "", ErrInvalid
		}
	}
	token, e = d.Token()
	if e != nil || token != json.Delim('}') || !confirmed || len(seen) != 2 {
		return "", ErrInvalid
	}
	if e = d.Decode(&struct{}{}); e != io.EOF {
		return "", ErrInvalid
	}
	if _, e = revisionNumber(revision); e != nil {
		return "", e
	}
	return revision, nil
}

func disconnectError(e error) error {
	switch {
	case errors.Is(e, ErrInvalid):
		return ErrInvalid
	case errors.Is(e, ErrConflict):
		return ErrConflict
	case errors.Is(e, ErrMissing):
		return ErrMissing
	}
	var p *pgconn.PgError
	if errors.As(e, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "P0003":
			return ErrConflict
		case "22023":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

// Disconnect fences local use and reports the absence of a provider revoker.
// It never reads/decrypts credentials, sends remote traffic or claims revocation.
func (s *Service) Disconnect(ctx context.Context, actor, client, id, revision string) (DisconnectResult, error) {
	expected, e := revisionNumber(revision)
	if e != nil || ctx == nil || correlation.ID(ctx) == "" || !validID(actor) || !validID(client) || !validID(id) {
		return DisconnectResult{}, ErrInvalid
	}
	actor, client, id = strings.ToLower(actor), strings.ToLower(client), strings.ToLower(id)
	var result DisconnectResult
	e = audit.WithTransaction(ctx, s.pool, func(ctx context.Context, q audit.Queries) (audit.Event, error) {
		var c Connection
		var changed bool
		if e := q.QueryRow(ctx, `SELECT id::text,client_id::text,provider,state,revision::text,created_at,updated_at,changed FROM app.integration_local_disconnect($1::uuid,$2::uuid,$3::uuid,$4)`, actor, client, id, expected).Scan(&c.ID, &c.ClientID, &c.Provider, &c.State, &c.Revision, &c.CreatedAt, &c.UpdatedAt, &changed); e != nil {
			return audit.Event{}, e
		}
		if !validConnection(c, client) || c.ID != id || c.State != "revocation_failed" || ctx.Err() != nil {
			return audit.Event{}, ErrUnavailable
		}
		c.CreatedAt, c.UpdatedAt = c.CreatedAt.UTC(), c.UpdatedAt.UTC()
		result = DisconnectResult{c, Revocation{Status: "unavailable", ManualActionRequired: true}}
		if !changed {
			if c.Revision != revision {
				return audit.Event{}, ErrUnavailable
			}
			// A freshly authorized no-op has no business mutation to audit. Roll back
			// its read/row lock while preserving the helper's mandatory event rule.
			return audit.Event{}, errUnchanged
		}
		if expected == math.MaxInt64 || c.Revision != strconv.FormatInt(expected+1, 10) {
			return audit.Event{}, ErrUnavailable
		}
		yes, next := true, expected+1
		return audit.Event{Actor: audit.Actor{Kind: audit.User, UserID: actor}, Action: audit.Updated,
			ResourceKind: "integration_connection", ResourceID: id, ClientID: client,
			Before: &audit.Snapshot{Exists: &yes, Revision: &expected}, After: &audit.Snapshot{Exists: &yes, Revision: &next},
			Metadata: audit.Metadata{Source: audit.HTTP}}, nil
	})
	if errors.Is(e, errUnchanged) {
		return result, nil
	}
	if e != nil {
		return DisconnectResult{}, disconnectError(e)
	}
	return result, nil
}
