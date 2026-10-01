package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/theroisey/else/backend/internal/administration"
	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/database"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if code := run(ctx, os.LookupEnv, os.Stdout); code != 0 {
		os.Exit(code)
	}
}

func run(ctx context.Context, lookup func(string) (string, bool), output io.Writer) int {
	c, err := config.Load(lookup)
	if err != nil {
		logger := slog.New(slog.NewJSONHandler(output, nil))
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{Level: c.LogLevel}))
	if ctx.Err() != nil {
		return 0
	}
	dbConfig, err := config.LoadDatabase(lookup, "DATABASE_URL")
	if err != nil {
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	pool, err := database.Open(ctx, dbConfig)
	if err != nil {
		logger.Error("database_startup_failed", "error_code", database.FailureCode(err))
		return 1
	}
	defer pool.Close()
	authConfig, err := config.LoadAuth(lookup)
	if err != nil {
		logger.Error("invalid_configuration", "detail", err.Error())
		return 1
	}
	authorizationService, err := authorization.NewService(pool)
	if err != nil {
		logger.Error("authorization_startup_failed", "error_code", "authorization_startup_failed")
		return 1
	}
	identityService, err := identity.NewService(pool, identity.ArgonPasswords{}, authorizationService)
	if err != nil {
		logger.Error("identity_startup_failed", "error_code", "identity_startup_failed")
		return 1
	}
	authHandler, err := identity.NewHandler(identityService, authConfig, logger)
	if err != nil {
		logger.Error("identity_startup_failed", "error_code", "identity_startup_failed")
		return 1
	}
	administrationService, err := administration.NewService(pool, identity.ArgonPasswords{})
	if err != nil {
		logger.Error("administration_startup_failed", "error_code", "administration_startup_failed")
		return 1
	}
	administrationHandler, err := administration.NewHandler(administrationService, authHandler, authorizationService, logger)
	if err != nil {
		logger.Error("administration_startup_failed", "error_code", "administration_startup_failed")
		return 1
	}
	server, err := httpapi.NewWithAdministration(c, logger, pool.Ping, authHandler, administrationHandler)
	if err != nil {
		logger.Error("server_configuration_invalid")
		return 1
	}
	if err := server.Run(ctx); err != nil {
		// Internal errors retain their cause, but public logs never print raw
		// transport errors or request-derived details.
		logger.Error("server_failed", "error_code", "server_failed")
		return 1
	}
	return 0
}
