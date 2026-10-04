package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/theroisey/else/backend/internal/analytics"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.LookupEnv, os.Stdout))
}

func run(ctx context.Context, args []string, lookup func(string) (string, bool), output io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	once := len(args) == 1 && args[0] == "--once"
	if ctx == nil || lookup == nil || (len(args) != 0 && !once) {
		logger.Error("analytics_worker_configuration_invalid")
		return 1
	}
	if ctx.Err() != nil {
		return 0
	}
	settings, err := keysource.LoadSettings(lookup)
	if err != nil || !settings.Enabled() {
		logger.Error("analytics_worker_key_startup_failed")
		return 1
	}
	ring, err := keysource.Read(ctx, settings)
	if err != nil {
		logger.Error("analytics_worker_key_startup_failed")
		return 1
	}
	db, err := config.LoadDatabase(lookup, "DATABASE_URL")
	if err != nil {
		logger.Error("analytics_worker_configuration_invalid")
		return 1
	}
	db.MaxConnections = 2
	pool, err := database.Open(ctx, db)
	if err != nil {
		logger.Error("analytics_worker_database_unavailable")
		return 1
	}
	defer pool.Close()
	if keysource.Preflight(ctx, pool, ring, settings.Restored()) != nil {
		logger.Error("analytics_worker_key_startup_failed")
		return 1
	}
	service, err := analytics.NewService(pool, ring)
	if err != nil {
		logger.Error("analytics_worker_startup_failed")
		return 1
	}
	worker, err := analytics.NewWorker(service)
	if err != nil {
		logger.Error("analytics_worker_startup_failed")
		return 1
	}
	for ctx.Err() == nil {
		didWork, err := worker.RunOnce(ctx)
		if ctx.Err() != nil {
			return 0
		}
		if err != nil {
			logger.Error("analytics_worker_operation_unavailable")
			if once {
				return 1
			}
		}
		if err == nil && service.Prune(ctx) != nil {
			logger.Error("analytics_worker_retention_unavailable")
			if once {
				return 1
			}
		}
		if once {
			return 0
		}
		if didWork && err == nil {
			continue
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return 0
		case <-timer.C:
		}
	}
	return 0
}
