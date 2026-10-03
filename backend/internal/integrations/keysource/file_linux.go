//go:build linux

package keysource

import (
	"context"
	"os"
	"syscall"

	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

func safeStat(info *syscall.Stat_t) bool {
	return info.Mode&syscall.S_IFMT == syscall.S_IFREG && info.Mode&0400 != 0 && info.Mode&07777 & ^uint32(0600) == 0 &&
		(info.Uid == uint32(os.Geteuid()) || info.Uid == 0) && info.Nlink == 1 && info.Size > 0 && info.Size <= credentials.MaxKeyringBytes
}

// Read refuses symlinks and special files without blocking on FIFOs/devices.
// The descriptor, not a preceding path stat, owns the validation boundary.
func Read(ctx context.Context, settings Settings) (*credentials.Keyring, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	if !settings.Enabled() {
		return nil, nil
	}
	fd, err := syscall.Open(settings.state.file, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	file := os.NewFile(uintptr(fd), "integration-key-source")
	if file == nil {
		_ = syscall.Close(fd)
		return nil, ErrUnavailable
	}
	defer func() { _ = file.Close() }()
	var before, after syscall.Stat_t
	if syscall.Fstat(fd, &before) != nil || !safeStat(&before) {
		return nil, ErrUnavailable
	}
	ring, err := credentials.ReadKeyring(file)
	if err != nil || syscall.Fstat(fd, &after) != nil || !safeStat(&after) || before.Dev != after.Dev || before.Ino != after.Ino ||
		before.Mode != after.Mode || before.Uid != after.Uid || before.Gid != after.Gid || before.Size != after.Size ||
		before.Mtim != after.Mtim || before.Ctim != after.Ctim || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	return ring, nil
}
