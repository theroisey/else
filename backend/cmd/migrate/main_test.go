package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestInvalidCommandsAndSettingsAreSafe(t *testing.T) {
	for _, args := range [][]string{nil, {"secret-value"}, {"up", "secret-value"}, {"up"}} {
		var output bytes.Buffer
		code := run(context.Background(), args, func(string) (string, bool) { return "secret-value", true }, &output)
		if code != 1 || strings.Contains(output.String(), "secret-value") {
			t.Fatal("unsafe migration command validation")
		}
	}
}

func TestUnexpectedFailureDoesNotExposePanicDiagnostics(t *testing.T) {
	var output bytes.Buffer
	code := run(context.Background(), []string{"up"}, func(string) (string, bool) { panic("secret-value") }, &output)
	if code != 1 || strings.Contains(output.String(), "secret-value") || !strings.Contains(output.String(), "migration_internal_error") {
		t.Fatal("unsafe internal migration failure")
	}
}
