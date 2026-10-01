package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func listenerForTest(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	return listener
}

func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("lifecycle signal did not arrive")
	}
}

func waitResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("server lifecycle did not finish")
		return nil
	}
}

func TestGracefulShutdownWaitsForActiveRequestAndDisablesReadiness(t *testing.T) {
	s := testServer(t, func(context.Context) error { return nil })
	started := make(chan struct{})
	release := make(chan struct{})
	shutdownStarted := make(chan struct{})
	s.httpServer.RegisterOnShutdown(func() { close(shutdownStarted) })
	s.httpServer.Handler = RequestMiddleware(s.logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/slow" {
			s.handler(w, r)
			return
		}
		close(started)
		select {
		case <-release:
			writeJSON(w, r, http.StatusOK, map[string]string{"status": "finished"})
		case <-r.Context().Done():
		}
	}))
	listener := listenerForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	serverResult := make(chan error, 1)
	go func() { serverResult <- s.Serve(ctx, listener) }()
	requestResult := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://" + listener.Addr().String() + "/slow")
		if err == nil {
			defer response.Body.Close()
			_, err = io.ReadAll(response.Body)
			if response.StatusCode != http.StatusOK {
				err = errors.New("active request did not finish successfully")
			}
		}
		requestResult <- err
	}()
	waitSignal(t, started)
	cancel()
	waitSignal(t, shutdownStarted)
	w := httptest.NewRecorder()
	s.handler(w, httptest.NewRequest("GET", "/ready", nil))
	if w.Code != 503 {
		t.Fatalf("readiness stayed healthy during shutdown: %d", w.Code)
	}
	select {
	case err := <-serverResult:
		t.Fatalf("server returned before active request finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := waitResult(t, requestResult); err != nil {
		t.Fatal(err)
	}
	if err := waitResult(t, serverResult); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownDeadlineForceClosesActiveConnection(t *testing.T) {
	c := testConfig(t)
	c.ShutdownTimeout = 20 * time.Millisecond
	s, err := New(c, slog.New(slog.NewJSONHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	requestCanceled := make(chan struct{})
	s.httpServer.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(requestCanceled)
	})
	listener := listenerForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	serverResult := make(chan error, 1)
	go func() { serverResult <- s.Serve(ctx, listener) }()
	requestResult := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://" + listener.Addr().String() + "/blocked")
		if response != nil {
			response.Body.Close()
		}
		requestResult <- err
	}()
	waitSignal(t, started)
	cancel()
	if err := waitResult(t, serverResult); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown did not preserve its deadline error: %v", err)
	}
	waitSignal(t, requestCanceled)
	if err := waitResult(t, requestResult); err == nil {
		t.Fatal("force-closed connection unexpectedly succeeded")
	}
}

func TestCanceledServeClosesListener(t *testing.T) {
	s := testServer(t, nil)
	listener := listenerForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Serve(ctx, listener); err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond)
	if err == nil {
		connection.Close()
		t.Fatal("canceled serve leaked its listener")
	}
}

func TestUnexpectedListenerFailureIsReturned(t *testing.T) {
	s := testServer(t, nil)
	listener := listenerForTest(t)
	listener.Close()
	if err := s.Serve(context.Background(), listener); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("listener failure was lost: %v", err)
	}
}

func TestConstructorRejectsInvalidConfigurationAndMissingLogger(t *testing.T) {
	c := testConfig(t)
	c.WriteTimeout = 0
	if _, err := New(c, slog.Default(), nil); err == nil {
		t.Fatal("invalid HTTP timeout was accepted")
	}
	if _, err := New(testConfig(t), nil, nil); err == nil {
		t.Fatal("missing structured logger was accepted")
	}
}
