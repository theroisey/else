package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func environment(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestLoadDefaultsAndOverrides(t *testing.T) {
	defaults, err := Load(environment(nil))
	if err != nil {
		t.Fatal(err)
	}
	if defaults.Address != "127.0.0.1:8080" || defaults.LogLevel != slog.LevelInfo || defaults.RequestTimeout != 5*time.Second {
		t.Fatalf("unsafe default address or log level: %+v", defaults)
	}
	overridden, err := Load(environment(map[string]string{
		"HTTP_ADDRESS": "[::1]:8081", "LOG_LEVEL": "warn",
		"HTTP_READ_HEADER_TIMEOUT": "2s", "HTTP_READ_TIMEOUT": "20s",
		"HTTP_WRITE_TIMEOUT": "10s", "HTTP_IDLE_TIMEOUT": "30s",
		"HTTP_REQUEST_TIMEOUT":  "4s",
		"HTTP_SHUTDOWN_TIMEOUT": "3s", "HTTP_READINESS_TIMEOUT": "500ms",
		"HTTP_MAX_HEADER_BYTES": "8192",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if overridden.Address != "[::1]:8081" || overridden.LogLevel != slog.LevelWarn ||
		overridden.ReadinessTimeout != 500*time.Millisecond || overridden.MaxHeaderBytes != 8192 ||
		overridden.ReadHeaderTimeout != 2*time.Second || overridden.ReadTimeout != 20*time.Second ||
		overridden.WriteTimeout != 10*time.Second || overridden.IdleTimeout != 30*time.Second ||
		overridden.ShutdownTimeout != 3*time.Second || overridden.RequestTimeout != 4*time.Second {
		t.Fatalf("configuration overrides did not apply: %+v", overridden)
	}
}

func TestLoadRejectsUnsafeConfigurationWithoutEchoingValues(t *testing.T) {
	for _, test := range []struct {
		name   string
		values map[string]string
	}{
		{"address empty", map[string]string{"HTTP_ADDRESS": ""}},
		{"address URL", map[string]string{"HTTP_ADDRESS": "https://secret-value:8080"}},
		{"address injection", map[string]string{"HTTP_ADDRESS": "secret-value\n:8080"}},
		{"missing port", map[string]string{"HTTP_ADDRESS": "127.0.0.1"}},
		{"port zero", map[string]string{"HTTP_ADDRESS": "127.0.0.1:0"}},
		{"port overflow", map[string]string{"HTTP_ADDRESS": "127.0.0.1:65536"}},
		{"port name", map[string]string{"HTTP_ADDRESS": "127.0.0.1:secret-value"}},
		{"signed port", map[string]string{"HTTP_ADDRESS": "127.0.0.1:+8080"}},
		{"log level", map[string]string{"LOG_LEVEL": "secret-value"}},
		{"duration empty", map[string]string{"HTTP_READ_TIMEOUT": ""}},
		{"duration invalid", map[string]string{"HTTP_READ_TIMEOUT": "secret-value"}},
		{"duration zero", map[string]string{"HTTP_IDLE_TIMEOUT": "0s"}},
		{"duration negative", map[string]string{"HTTP_SHUTDOWN_TIMEOUT": "-1s"}},
		{"duration excessive", map[string]string{"HTTP_WRITE_TIMEOUT": "6m"}},
		{"header timeout exceeds read", map[string]string{"HTTP_READ_TIMEOUT": "1s"}},
		{"readiness exceeds write", map[string]string{"HTTP_READINESS_TIMEOUT": "20s"}},
		{"readiness equals write", map[string]string{"HTTP_READINESS_TIMEOUT": "15s"}},
		{"request invalid", map[string]string{"HTTP_REQUEST_TIMEOUT": "secret-value"}},
		{"request zero", map[string]string{"HTTP_REQUEST_TIMEOUT": "0s"}},
		{"request excessive", map[string]string{"HTTP_REQUEST_TIMEOUT": "6m"}},
		{"request equals write", map[string]string{"HTTP_REQUEST_TIMEOUT": "15s"}},
		{"request exceeds write", map[string]string{"HTTP_REQUEST_TIMEOUT": "20s"}},
		{"request equals readiness", map[string]string{"HTTP_REQUEST_TIMEOUT": "2s"}},
		{"header integer invalid", map[string]string{"HTTP_MAX_HEADER_BYTES": "secret-value"}},
		{"headers too small", map[string]string{"HTTP_MAX_HEADER_BYTES": "0"}},
		{"headers too large", map[string]string{"HTTP_MAX_HEADER_BYTES": "65537"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := Load(environment(test.values))
			if err == nil {
				t.Fatal("invalid configuration accepted")
			}
			if strings.Contains(err.Error(), "secret-value") {
				t.Fatalf("raw configuration value leaked: %s", err)
			}
		})
	}
}
