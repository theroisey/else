package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/term"

	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/identity"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		logger.Error("bootstrap_failed", "error_code", "interactive_terminal_required")
		os.Exit(1)
	}
	fmt.Fprint(os.Stderr, "Initial administrator password: ")
	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		logger.Error("bootstrap_failed", "error_code", "password_read_failed")
		os.Exit(1)
	}
	if run(ctx, os.LookupEnv, string(password), logger) != 0 {
		os.Exit(1)
	}
}

func run(ctx context.Context, lookup func(string) (string, bool), password string, logger *slog.Logger) int {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	email, emailOK := lookup("BOOTSTRAP_ADMIN_EMAIL")
	name, nameOK := lookup("BOOTSTRAP_ADMIN_NAME")
	if !emailOK || !nameOK {
		logger.Error("bootstrap_failed", "error_code", "bootstrap_configuration_invalid")
		return 1
	}
	dbConfig, err := config.LoadDatabase(lookup, "BOOTSTRAP_DATABASE_URL")
	if err != nil {
		logger.Error("bootstrap_failed", "error_code", "bootstrap_configuration_invalid")
		return 1
	}
	pool, err := database.Open(ctx, dbConfig)
	if err != nil {
		logger.Error("bootstrap_failed", "error_code", database.FailureCode(err))
		return 1
	}
	defer pool.Close()
	ctx = correlation.New(ctx)
	if _, err = identity.Bootstrap(ctx, pool, identity.ArgonPasswords{}, email, name, password); err != nil {
		logger.Error("bootstrap_failed", "error_code", "bootstrap_refused")
		return 1
	}
	logger.Info("bootstrap_completed")
	return 0
}
