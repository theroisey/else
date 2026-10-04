// Trusted offline restore verification. Reuses the runtime's read-only key gate.
package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := check(ctx); err != nil {
		slog.New(slog.NewJSONHandler(os.Stdout, nil)).Error("container_restore_preflight_failed")
		os.Exit(1)
	}
}

func check(ctx context.Context) error {
	settings, err := keysource.LoadSettings(os.LookupEnv)
	if err != nil || !settings.Enabled() || !settings.Restored() {
		return keysource.ErrUnavailable
	}
	ring, err := keysource.Read(ctx, settings)
	if err != nil {
		return keysource.ErrUnavailable
	}
	db, err := config.LoadDatabase(os.LookupEnv, "DATABASE_URL")
	if err != nil {
		return keysource.ErrUnavailable
	}
	db.MaxConnections = 1
	pool, err := database.Open(ctx, db)
	if err != nil {
		return keysource.ErrUnavailable
	}
	defer pool.Close()
	return keysource.Preflight(ctx, pool, ring, true)
}
