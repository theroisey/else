package auditreader

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	return &Service{pool}, nil
}
func databaseError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	var e *pgconn.PgError
	if errors.As(err, &e) {
		switch e.Code {
		case "P0002":
			return ErrMissing
		case "22023":
			return ErrInvalid
		case "P0001":
			return ErrDenied
		}
	}
	return err
}
func optional(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (s *Service) List(ctx context.Context, actor, scope string, f Filter) (Page, error) {
	p := Page{Data: []Summary{}, Page: Pagination{Limit: f.Limit}}
	if !validID(actor) {
		return p, ErrInvalid
	}
	normalized, err := normalize(scope, f)
	if err != nil {
		return p, err
	}
	f = normalized
	scope = strings.ToLower(scope)
	cursor, err := decodeCursor(scope, f)
	if err != nil {
		return p, err
	}
	var afterTime, afterID any
	if cursor != nil {
		afterTime, afterID = cursor.Time, cursor.ID
	}
	// The deadline also bounds sparse-filter/visibility scans; page size alone
	// does not bound the work needed to find eligible historical rows.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx, `SELECT id::text,schema_version,occurred_at,actor_kind,actor_user_id::text,event_type,resource_kind,resource_id::text,client_id::text,request_id
 FROM app.audit_reader_list($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::uuid,$9::text,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13::uuid,$14)`,
		actor, optional(scope), optional(f.ClientID), optional(f.ActorID), optional(f.ActorKind), optional(f.EventType), optional(f.ResourceKind), optional(f.ResourceID), optional(f.RequestID), f.From, f.To, afterTime, afterID, f.Limit+1)
	if err != nil {
		return p, databaseError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item Summary
		if err := rows.Scan(&item.ID, &item.SchemaVersion, &item.OccurredAt, &item.ActorKind, &item.ActorUserID, &item.EventType, &item.ResourceKind, &item.ResourceID, &item.ClientID, &item.RequestID); err != nil {
			return p, err
		}
		if !item.valid(scope) || f.ClientID != "" && (item.ClientID == nil || *item.ClientID != f.ClientID) {
			return p, errData
		}
		item.OccurredAt = item.OccurredAt.UTC()
		if len(p.Data) == f.Limit {
			next := encodeCursor(scope, f, p.Data[len(p.Data)-1])
			p.Page.NextCursor = &next
			break
		}
		p.Data = append(p.Data, item)
	}
	return p, databaseError(rows.Err())
}
func (s *Service) Detail(ctx context.Context, actor, scope, id string) (Detail, error) {
	var d Detail
	if !validID(actor) || !validID(id) || scope != "" && !validID(scope) {
		return d, ErrInvalid
	}
	scope = strings.ToLower(scope)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var before, after, metadata []byte
	err := s.pool.QueryRow(ctx, `SELECT id::text,schema_version,occurred_at,actor_kind,actor_user_id::text,event_type,resource_kind,resource_id::text,client_id::text,request_id,before_state,after_state,metadata
 FROM app.audit_reader_detail($1::uuid,$2::uuid,$3::uuid)`, actor, optional(scope), id).Scan(&d.ID, &d.SchemaVersion, &d.OccurredAt, &d.ActorKind, &d.ActorUserID, &d.EventType, &d.ResourceKind, &d.ResourceID, &d.ClientID, &d.RequestID, &before, &after, &metadata)
	if err != nil {
		return d, databaseError(err)
	}
	if !d.Summary.valid(scope) || d.ID != strings.ToLower(id) {
		return d, errData
	}
	d.OccurredAt = d.OccurredAt.UTC()
	d.Before, err = projectSnapshot(before, d.ResourceKind)
	if err != nil {
		return d, err
	}
	d.After, err = projectSnapshot(after, d.ResourceKind)
	if err != nil {
		return d, err
	}
	d.Metadata, err = projectMetadata(metadata)
	return d, err
}
