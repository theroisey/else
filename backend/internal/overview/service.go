package overview

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/theroisey/else/backend/internal/activity"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) (*Service, error) {
	if pool == nil {
		return nil, ErrInvalid
	}
	return &Service{pool}, nil
}
func (s *Service) Read(ctx context.Context, actor, client string) (Overview, error) {
	var result Overview
	if !validID(actor) || !validID(client) {
		return result, ErrInvalid
	}
	var raw []byte
	if e := s.pool.QueryRow(ctx, `SELECT app.client_overview($1::uuid,$2::uuid)`, actor, client).Scan(&raw); e != nil {
		var p *pgconn.PgError
		if errors.As(e, &p) && p.Code == "P0002" {
			return result, ErrMissing
		}
		return result, e
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&result); e != nil {
		return Overview{}, e
	}
	if result.Client.ID != strings.ToLower(client) || result.AsOf.IsZero() || !result.HorizonEnd.Equal(result.AsOf.AddDate(0, 0, 7)) {
		return Overview{}, ErrInvalid
	}
	result.AsOf = result.AsOf.UTC()
	result.HorizonEnd = result.HorizonEnd.UTC()
	if result.Activity != nil {
		if len(result.Activity.Items) > QueueLimit {
			return Overview{}, ErrInvalid
		}
		for i := range result.Activity.Items {
			item := &result.Activity.Items[i]
			if item.ClientID != result.Client.ID {
				return Overview{}, ErrInvalid
			}
			if e := activity.Describe(item); e != nil {
				return Overview{}, e
			}
		}
	}
	return result, nil
}
