package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"sync/atomic"

	"github.com/theroisey/else/backend/internal/config"
)

type Server struct {
	config     config.Config
	logger     *slog.Logger
	readiness  ReadinessCheck
	draining   atomic.Bool
	httpServer *http.Server
}

func New(c config.Config, logger *slog.Logger, readiness ReadinessCheck) (*Server, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		return nil, fmt.Errorf("HTTP logger is required")
	}
	s := &Server{config: c, logger: logger, readiness: readiness}
	s.httpServer = &http.Server{
		Addr: c.Address, Handler: RequestMiddleware(logger, http.HandlerFunc(s.handler)),
		ReadHeaderTimeout: c.ReadHeaderTimeout, ReadTimeout: c.ReadTimeout,
		WriteTimeout: c.WriteTimeout, IdleTimeout: c.IdleTimeout,
		MaxHeaderBytes: c.MaxHeaderBytes,
		// net/http's default diagnostic lines may contain raw request or panic
		// details. Preserve a safe structured event instead of raw text.
		ErrorLog: log.New(safeDiagnosticWriter{logger: logger}, "", 0),
	}
	return s, nil
}

func (s *Server) Run(ctx context.Context) error {
	if ctx.Err() != nil {
		return nil
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", s.config.Address)
	if err != nil {
		return fmt.Errorf("HTTP listen failed: %w", err)
	}
	return s.Serve(ctx, listener)
}

// Serve owns and closes the listener. A Server instance is used for one lifecycle.
func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	if ctx.Err() != nil {
		return listener.Close()
	}
	s.logger.InfoContext(ctx, "server_started", "address", listener.Addr().String())
	result := make(chan error, 1)
	go func() {
		result <- s.httpServer.Serve(listener)
	}()
	select {
	case err := <-result:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP serve failed: %w", err)
		}
		return nil
	case <-ctx.Done():
		s.draining.Store(true)
		s.logger.Info("server_stopping")
		shutdownContext, cancel := context.WithTimeout(context.Background(), s.config.ShutdownTimeout)
		defer cancel()
		shutdownErr := s.httpServer.Shutdown(shutdownContext)
		if shutdownErr != nil {
			closeErr := s.httpServer.Close()
			<-result
			s.logger.Error("server_shutdown_failed", "error_code", "shutdown_failed")
			return fmt.Errorf("HTTP shutdown failed: %w", errors.Join(shutdownErr, closeErr))
		}
		serveErr := <-result
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return fmt.Errorf("HTTP serve failed: %w", serveErr)
		}
		s.logger.Info("server_stopped")
		return nil
	}
}

type safeDiagnosticWriter struct {
	logger *slog.Logger
}

func (w safeDiagnosticWriter) Write(value []byte) (int, error) {
	w.logger.Error("http_transport_error")
	return len(value), nil
}
