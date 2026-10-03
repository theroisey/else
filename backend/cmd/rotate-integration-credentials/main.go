package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/theroisey/else/backend/internal/integrations/rotationcommand"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := rotationcommand.Run(ctx, os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
