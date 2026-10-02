package activity

import (
	"context"
	"errors"
	"strings"

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
	var p *pgconn.PgError
	if errors.As(err, &p) {
		switch p.Code {
		case "P0002":
			return ErrMissing
		case "22023":
			return ErrInvalid
		}
	}
	return err
}
func (s *Service) List(ctx context.Context, actor, client string, f Filter) (Page, error) {
	p := Page{Data: []Item{}, Page: Pagination{Limit: f.Limit}}
	if !validID(actor) || !validID(client) || f.Limit < 1 || f.Limit > 100 {
		return p, ErrInvalid
	}
	client = strings.ToLower(client)
	cursor, err := decodeCursor(client, f.Cursor)
	if err != nil {
		return p, err
	}
	var afterTime, afterID any
	if cursor != nil {
		afterTime, afterID = cursor.Time, cursor.ID
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text,client_id::text,occurred_at,event_type,resource_kind,resource_id::text FROM app.activity_list($1::uuid,$2::uuid,$3::timestamptz,$4::uuid,$5)`, actor, client, afterTime, afterID, f.Limit+1)
	if err != nil {
		return p, databaseError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item Item
		if err := rows.Scan(&item.ID, &item.ClientID, &item.OccurredAt, &item.EventType, &item.ResourceKind, &item.ResourceID); err != nil {
			return p, err
		}
		if item.ClientID != client || Describe(&item) != nil {
			return p, ErrInvalid
		}
		if len(p.Data) == f.Limit {
			next := encodeCursor(client, p.Data[len(p.Data)-1])
			p.Page.NextCursor = &next
			break
		}
		p.Data = append(p.Data, item)
	}
	return p, databaseError(rows.Err())
}
