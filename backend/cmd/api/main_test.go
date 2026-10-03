package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestInvalidConfigurationFailsWithSafeStructuredOutput(t *testing.T) {
	var output bytes.Buffer
	code := run(context.Background(), func(key string) (string, bool) {
		if key == "HTTP_ADDRESS" {
			return "https://password-secret:8080", true
		}
		return "", false
	}, &output)
	if code != 1 || strings.Contains(output.String(), "password-secret") {
		t.Fatalf("invalid configuration did not fail safely: code %d, output %s", code, output.String())
	}
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["msg"] != "invalid_configuration" || !strings.Contains(event["detail"].(string), "HTTP_ADDRESS") {
		t.Fatalf("missing safe diagnostic: %v", event)
	}
}

func TestCanceledStartupSucceedsWithoutListening(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if code := run(ctx, func(string) (string, bool) { return "", false }, &output); code != 0 {
		t.Fatalf("canceled startup returned %d", code)
	}
}

func TestMissingDatabaseConfigurationFailsSafely(t *testing.T) {
	var output bytes.Buffer
	if code := run(context.Background(), func(string) (string, bool) { return "", false }, &output); code != 1 {
		t.Fatal("missing database URL accepted")
	}
	if !strings.Contains(output.String(), "DATABASE_URL") {
		t.Fatal("missing safe setting diagnostic")
	}
}

func TestConfiguredIntegrationKeyFailurePrecedesDatabaseAndRedactsSource(t *testing.T) {
	for _, values := range []map[string]string{
		{"INTEGRATION_KEYRING_MODE": "restored"},
		{"INTEGRATION_KEYRING_FILE": "/nonexistent/synthetic-private-key-path"},
		{"INTEGRATION_KEYRING_FILE": "/dev/null"},
	} {
		var output bytes.Buffer
		code := run(context.Background(), func(name string) (string, bool) { v, ok := values[name]; return v, ok }, &output)
		if code != 1 || !strings.Contains(output.String(), "integration_key_startup_failed") || strings.Contains(output.String(), "synthetic-private") || strings.Contains(output.String(), "/dev/null") || strings.Contains(output.String(), "DATABASE_URL") {
			t.Fatal("key startup failed unsafely")
		}
	}
}
