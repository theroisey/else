package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestWorkerRejectsUnsafeArgumentsAndMissingProtectedKeysWithoutDetails(t *testing.T) {
	for _, args := range [][]string{{"--token=synthetic-private"}, {"--once", "--endpoint=https://private.example.com"}, {"--once"}, nil} {
		var output bytes.Buffer
		lookup := func(string) (string, bool) { return "", false }
		if run(context.Background(), args, lookup, &output) != 1 || strings.Contains(output.String(), "synthetic-private") || strings.Contains(output.String(), "private.example.com") {
			t.Fatal("worker accepted unprotected setup or exposed argument values")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if run(ctx, nil, func(string) (string, bool) { t.Fatal("canceled worker read setup"); return "", false }, &output) != 0 || output.Len() != 0 {
		t.Fatal("canceled worker touched startup")
	}
}
