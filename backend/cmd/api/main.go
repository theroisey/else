package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/theroisey/else/backend/internal/config"
	httpapi "github.com/theroisey/else/backend/internal/http"
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
	server, err := httpapi.New(c, logger, nil)
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
