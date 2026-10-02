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
	config         config.Config
	logger         *slog.Logger
	readiness      ReadinessCheck
	auth           http.Handler
	administration http.Handler
	clients        http.Handler
	tasks          http.Handler
	draining       atomic.Bool
	httpServer     *http.Server
}

func NewWithTasks(c config.Config, logger *slog.Logger, readiness ReadinessCheck, auth, administration, clients, tasks http.Handler) (*Server, error) {
	if tasks == nil {
		return nil, fmt.Errorf("task handler is required")
	}
	server, err := NewWithClients(c, logger, readiness, auth, administration, clients)
	if err != nil {
		return nil, err
	}
	server.tasks = tasks
	return server, nil
}

func NewWithClients(c config.Config, logger *slog.Logger, readiness ReadinessCheck, auth, administration, clients http.Handler) (*Server, error) {
	if clients == nil {
		return nil, fmt.Errorf("client handler is required")
	}
	server, err := NewWithAdministration(c, logger, readiness, auth, administration)
	if err != nil {
		return nil, err
	}
	server.clients = clients
	return server, nil
}

func NewWithAdministration(c config.Config, logger *slog.Logger, readiness ReadinessCheck, auth, administration http.Handler) (*Server, error) {
	if auth == nil || administration == nil {
		return nil, fmt.Errorf("protected handlers are required")
	}
	server, err := New(c, logger, readiness, auth)
	if err != nil {
		return nil, err
	}
	server.administration = administration
	return server, nil
}

func New(c config.Config, logger *slog.Logger, readiness ReadinessCheck, auth ...http.Handler) (*Server, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		return nil, fmt.Errorf("HTTP logger is required")
	}
	s := &Server{config: c, logger: logger, readiness: readiness}
	if len(auth) > 1 {
		return nil, fmt.Errorf("at most one authentication handler is allowed")
	}
	if len(auth) == 1 {
		s.auth = auth[0]
	}
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
