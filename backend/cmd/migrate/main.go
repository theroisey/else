package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/migrations"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.LookupEnv, os.Stdout))
}

func run(ctx context.Context, args []string, lookup func(string) (string, bool), output io.Writer) (code int) {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	defer func() {
		if recover() != nil {
			logger.Error("migration_internal_error")
			code = 1
		}
	}()
	if len(args) != 1 || (args[0] != "up" && args[0] != "down" && args[0] != "status") {
		logger.Error("invalid_migration_command", "usage", "migrate up|down|status")
		return 1
	}
	c, err := config.LoadDatabase(lookup, "MIGRATION_DATABASE_URL")
	if err != nil {
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	bounded, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	db, err := database.OpenMigration(bounded, c)
	if err != nil {
		logger.Error("migration_connection_failed", "error_code", database.FailureCode(err))
		return 1
	}
	defer db.Close()
	provider, err := database.MigrationProvider(db, migrations.Files)
	if err != nil {
		logger.Error("migration_configuration_failed")
		return 1
	}
	switch args[0] {
	case "up":
		var results []*goose.MigrationResult
		results, err = provider.Up(bounded)
		if err == nil {
			logger.Info("migrations_applied", "count", len(results))
		}
	case "down":
		_, err = provider.Down(bounded)
		if err == nil {
			logger.Info("migration_reverted")
		}
	case "status":
		var results []*goose.MigrationStatus
		results, err = provider.Status(bounded)
		if err == nil {
			for _, result := range results {
				logger.Info("migration_status", "version", result.Source.Version, "state", result.State)
			}
		}
	}
	if err != nil {
		logger.Error("migration_failed", "command", args[0], "error_code", database.FailureCode(err))
		return 1
	}
	return 0
}
