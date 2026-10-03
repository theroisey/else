//go:build !linux

package keysource

import (
	"context"

	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

// Configured key sources require the verified Linux descriptor policy.
func Read(ctx context.Context, settings Settings) (*credentials.Keyring, error) {
	if ctx == nil || ctx.Err() != nil || settings.Enabled() {
		return nil, ErrUnavailable
	}
	return nil, nil
}
