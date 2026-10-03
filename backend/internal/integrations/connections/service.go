package connections

import (
	"context"
	"errors"
	"strings"

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

const columns = "id::text,client_id::text,provider,state,revision::text,created_at,updated_at"

func databaseError(e error) error {
	var p *pgconn.PgError
	if errors.Is(e, pgx.ErrNoRows) || (errors.As(e, &p) && p.Code == "P0002") {
		return ErrMissing
	}
	if errors.As(e, &p) && p.Code == "22023" {
		return ErrInvalid
	}
	return e
}
func scan(row pgx.Row, client string) (Connection, error) {
	var c Connection
	if e := row.Scan(&c.ID, &c.ClientID, &c.Provider, &c.State, &c.Revision, &c.CreatedAt, &c.UpdatedAt); e != nil {
		return Connection{}, databaseError(e)
	}
	if !validConnection(c, client) {
		return Connection{}, ErrInvalid
	}
	c.CreatedAt = c.CreatedAt.UTC()
	c.UpdatedAt = c.UpdatedAt.UTC()
	return c, nil
}
func (s *Service) Detail(ctx context.Context, actor, client, id string) (Connection, error) {
	if !validID(actor) || !validID(client) || !validID(id) {
		return Connection{}, ErrInvalid
	}
	client = strings.ToLower(client)
	return scan(s.pool.QueryRow(ctx, "SELECT "+columns+" FROM app.integration_connection_read($1::uuid,$2::uuid,$3::uuid)", actor, client, id), client)
}
func (s *Service) List(ctx context.Context, actor, client string, f Filter) (Page, error) {
	p := Page{Data: []Connection{}, Page: Pagination{Limit: f.Limit}}
	if !validID(actor) || !validID(client) || f.Limit < 1 || f.Limit > 100 {
		return p, ErrInvalid
	}
	client = strings.ToLower(client)
	cursor, e := decodeCursor(client, f.Cursor)
	if e != nil {
		return p, e
	}
	rows, e := s.pool.Query(ctx, "SELECT "+columns+" FROM app.integration_connection_list($1::uuid,$2::uuid,$3::uuid,$4)", actor, client, cursor, f.Limit+1)
	if e != nil {
		return p, databaseError(e)
	}
	defer rows.Close()
	for rows.Next() {
		c, e := scan(rows, client)
		if e != nil {
			return Page{}, e
		}
		if len(p.Data) > 0 && c.ID <= p.Data[len(p.Data)-1].ID {
			return Page{}, ErrInvalid
		}
		if len(p.Data) == f.Limit {
			next := encodeCursor(client, p.Data[len(p.Data)-1].ID)
			p.Page.NextCursor = &next
			break
		}
		p.Data = append(p.Data, c)
	}
	if e = rows.Err(); e != nil {
		return Page{}, databaseError(e)
	}
	return p, nil
}
