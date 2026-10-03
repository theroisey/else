package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/theroisey/else/backend/internal/integrations/rotationcommand"
)

func main() {
	// Preserve the fixed output-failure path when an operator's stdout pipe closes.
	signal.Ignore(syscall.SIGPIPE)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := rotationcommand.Run(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
