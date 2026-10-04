//go:build integration

package integration

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type compiledAPI struct {
	Origin  string
	Client  *http.Client
	Context context.Context
	Logs    bytes.Buffer // Read only after Close has joined the process.
	close   func()
}

func (a *compiledAPI) Close() { a.close() }

// Compile before creating a database fixture so its lifetime excludes builds.
func buildCompiledAPI(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "api")
	buildContext, stopBuild := context.WithTimeout(context.Background(), 2*time.Minute)
	defer stopBuild()
	build := exec.CommandContext(buildContext, "sh", "scripts/build-api.sh", binary, "", "", "")
	build.Dir = "../.."
	build.Env = append(os.Environ(), "PATH="+filepath.Join(runtime.GOROOT(), "bin")+":"+os.Getenv("PATH"), "CGO_ENABLED=0")
	if build.Run() != nil {
		t.Fatal("compiled API build failed")
	}
	return binary
}

// Uses real production wiring and the checked-in runtime grants.
func startCompiledAPI(t *testing.T, f *administrationFixture, binary string) *compiledAPI {
	t.Helper()
	return startCompiledAPIWithRequestBudget(t, f, binary, 0)
}

func startCompiledAPIWithRequestBudget(t *testing.T, f *administrationFixture, binary string, budget time.Duration) *compiledAPI {
	t.Helper()
	grants, err := os.ReadFile("../../scripts/grant-runtime.sql")
	if err != nil {
		t.Fatal("runtime grant source unavailable")
	}
	sql := strings.ReplaceAll(strings.ReplaceAll(string(grants), "\\set ON_ERROR_STOP on", ""), "else_runtime", f.runtimeRole)
	if _, err := f.admin.Exec(f.base.ctx, sql); err != nil {
		t.Fatal("compiled API runtime grants failed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("private API address unavailable")
	}
	address := listener.Addr().String()
	_ = listener.Close()
	source, err := url.Parse(f.base.URL)
	if err != nil {
		t.Fatal("private runtime URL invalid")
	}
	cfg := f.runtime.Config().ConnConfig
	source.User = url.UserPassword(cfg.User, cfg.Password)
	ctx, cancel := context.WithCancel(f.base.ctx)
	a := &compiledAPI{Origin: "http://" + address, Client: &http.Client{Timeout: 2 * time.Second}, Context: ctx}
	command := exec.CommandContext(ctx, binary)
	command.Env = []string{"DATABASE_URL=" + source.String(), "AUTH_PUBLIC_ORIGIN=" + a.Origin, "AUTH_COOKIE_SECURE=false", "HTTP_ADDRESS=" + address}
	if budget > 0 {
		command.Env = append(command.Env, "HTTP_REQUEST_TIMEOUT="+budget.String(), "HTTP_READINESS_TIMEOUT="+(budget/3).String())
	}
	command.Stdout, command.Stderr = &a.Logs, &a.Logs
	if command.Start() != nil {
		cancel()
		t.Fatal("compiled API startup failed")
	}
	var once sync.Once
	a.close = func() { once.Do(func() { a.Client.CloseIdleConnections(); cancel(); _ = command.Wait() }) }
	t.Cleanup(a.Close)
	for n := 0; n < 100; n++ {
		r, err := a.Client.Get(a.Origin + "/ready")
		if err == nil {
			_ = r.Body.Close()
			if r.StatusCode == http.StatusOK {
				return a
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("compiled API readiness canceled")
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatal("compiled API not ready")
	return nil
}
