package database

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/theroisey/else/backend/internal/config"
)

func connectionConfig(c config.Database) (*pgx.ConnConfig, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if os.Getenv("PGSERVICE") != "" {
		return nil, fmt.Errorf("PGSERVICE is unsupported; use an explicit database URL")
	}
	u, _ := url.Parse(c.URL)
	query := u.Query()
	// Override implicit service/password/certificate files from ambient PG settings.
	for _, key := range []string{"servicefile", "passfile", "sslcert", "sslkey", "sslpassword"} {
		query.Set(key, "")
	}
	if !query.Has("sslrootcert") {
		query.Set("sslrootcert", "")
	}
	u.RawQuery = query.Encode()
	cpg, err := pgx.ParseConfig(u.String())
	if err != nil {
		return nil, fmt.Errorf("PostgreSQL configuration failed")
	}
	cpg.ConnectTimeout = c.ConnectTimeout
	cpg.RuntimeParams = map[string]string{
		"TimeZone": "UTC", "search_path": "pg_catalog,app", "application_name": "roisey-else",
	}
	// No query tracer is installed: SQL, URLs, and arguments are not log fields.
	return cpg, nil
}

func Open(ctx context.Context, c config.Database) (*pgxpool.Pool, error) {
	conn, err := connectionConfig(c)
	if err != nil {
		return nil, err
	}
	pc, err := pgxpool.ParseConfig(conn.ConnString())
	if err != nil {
		return nil, fmt.Errorf("PostgreSQL pool configuration failed")
	}
	pc.ConnConfig = conn
	pc.MaxConns = c.MaxConnections
	pc.MinConns = 0
	pc.MaxConnLifetime = 30 * time.Minute
	pc.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("PostgreSQL pool creation failed: %w", err)
	}
	startup, cancel := context.WithTimeout(ctx, c.ConnectTimeout)
	defer cancel()
	if err := pool.Ping(startup); err != nil {
		pool.Close()
		return nil, fmt.Errorf("PostgreSQL startup check failed: %w", err)
	}
	return pool, nil
}

// OpenMigration uses a separate SQL connection and never runs inside the HTTP process.
func OpenMigration(ctx context.Context, c config.Database) (*sql.DB, error) {
	conn, err := connectionConfig(c)
	if err != nil {
		return nil, err
	}
	conn.RuntimeParams["search_path"] = "pg_catalog,public"
	conn.RuntimeParams["application_name"] = "roisey-else-migrate"
	conn.RuntimeParams["statement_timeout"] = "30000"
	conn.RuntimeParams["lock_timeout"] = "5000"
	db := stdlib.OpenDB(*conn)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	startup, cancel := context.WithTimeout(ctx, c.ConnectTimeout)
	defer cancel()
	if err := db.PingContext(startup); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("PostgreSQL migration connection failed: %w", err)
	}
	return db, nil
}
