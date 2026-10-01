// Package correlation carries server-owned IDs across transport and storage.
package correlation

import (
	"context"
	"crypto/rand"
)

type key struct{}

// New creates a fresh ID for an HTTP request or trusted internal operation.
// It deliberately does not accept a caller-supplied identifier.
func New(ctx context.Context) context.Context {
	return context.WithValue(ctx, key{}, rand.Text())
}

func ID(ctx context.Context) string {
	id, _ := ctx.Value(key{}).(string)
	return id
}
