//go:build linux

package keysource

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/theroisey/else/backend/internal/integrations/credentials"
)

func syntheticDocument() []byte {
	return []byte(fmt.Sprintf(`{"active_key_id":"synthetic-startup","keys":[{"id":"synthetic-startup","key_base64":"%s"}]}`, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x72}, 32))))
}
func testSettings(t *testing.T, path string) Settings {
	t.Helper()
	s, e := LoadSettings(env(map[string]string{"INTEGRATION_KEYRING_FILE": path}))
	if e != nil {
		t.Fatal("test settings invalid")
	}
	return s
}
func TestProtectedRegularFileLoadingAndCopiedIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synthetic.json")
	if os.WriteFile(path, syntheticDocument(), 0600) != nil {
		t.Fatal("fixture file failed")
	}
	ring, e := Read(context.Background(), testSettings(t, path))
	if e != nil || ring == nil {
		t.Fatal("protected file rejected", e)
	}
	labels, digests, e := ring.KeyIdentities()
	if e != nil || len(labels) != 1 || labels[0] != "synthetic-startup" {
		t.Fatal("identity projection failed")
	}
	_, before, _ := ring.ActiveKeyIdentity()
	clear(digests[0])
	labels[0] = "mutated"
	_, after, _ := ring.ActiveKeyIdentity()
	if before != after {
		t.Fatal("caller mutated key identity")
	}
	if os.Chmod(path, 0400) != nil {
		t.Fatal("fixture mode failed")
	}
	if _, e := Read(context.Background(), testSettings(t, path)); e != nil {
		t.Fatal("read-only file rejected")
	}
	if r, e := Read(context.Background(), Settings{}); e != nil || r != nil {
		t.Fatal("disabled source read keys")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r, e := Read(ctx, testSettings(t, path)); e != ErrUnavailable || r != nil {
		t.Fatal("cancelled file read accepted")
	}
}
func TestFileSourcesRejectInsecureMalformedAndSpecialInputs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "synthetic-private.json")
	settings := testSettings(t, path)
	for _, mode := range []os.FileMode{0000, 0200, 0500, 0640, 0604, 0666, os.ModeSetuid | 0600} {
		if os.WriteFile(path, syntheticDocument(), 0600) != nil || os.Chmod(path, mode) != nil {
			t.Fatal("fixture mode failed")
		}
		if r, e := Read(context.Background(), settings); e != ErrUnavailable || r != nil {
			t.Fatal("insecure source accepted", mode)
		}
		if os.Chmod(path, 0600) != nil {
			t.Fatal("fixture chmod failed")
		}
	}
	for _, data := range [][]byte{nil, []byte(`{"private":"synthetic-secret-parser-value"}`), bytes.Repeat([]byte{'x'}, credentials.MaxKeyringBytes+1)} {
		if os.WriteFile(path, data, 0600) != nil {
			t.Fatal("fixture write failed")
		}
		if r, e := Read(context.Background(), settings); e != ErrUnavailable || r != nil {
			t.Fatal("invalid key file accepted")
		}
	}
	if os.WriteFile(path, syntheticDocument(), 0600) != nil {
		t.Fatal("fixture write failed")
	}
	symlink := filepath.Join(dir, "symlink")
	hardlink := filepath.Join(dir, "hardlink")
	fifo := filepath.Join(dir, "fifo")
	if os.Symlink(path, symlink) != nil || os.Link(path, hardlink) != nil || syscall.Mkfifo(fifo, 0600) != nil {
		t.Fatal("special fixtures failed")
	}
	for _, path := range []string{symlink, hardlink, fifo, dir, filepath.Join(dir, "missing"), "/dev/null"} {
		if r, e := Read(context.Background(), testSettings(t, path)); e != ErrUnavailable || r != nil {
			t.Fatal("special/missing source accepted")
		}
	}
}
func TestDescriptorOwnershipAndPermissionPolicy(t *testing.T) {
	good := syscall.Stat_t{Mode: syscall.S_IFREG | 0400, Uid: uint32(os.Geteuid()), Nlink: 1, Size: 1}
	if !safeStat(&good) {
		t.Fatal("valid descriptor refused")
	}
	foreign := good
	foreign.Uid = uint32(os.Geteuid()) + 1
	if foreign.Uid == 0 {
		foreign.Uid = 2
	}
	if safeStat(&foreign) {
		t.Fatal("foreign owner accepted")
	}
	root := good
	root.Uid = 0
	if !safeStat(&root) {
		t.Fatal("protected root file refused")
	}
}
