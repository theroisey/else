// Package keysource loads protected deployment keys and checks configured
// startup prerequisites. It has no HTTP surface or provider/credential writer.
package keysource

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"unicode"
)

var ErrUnavailable = errors.New("integration key startup unavailable")

type Settings struct{ state *settingsState }
type settingsState struct {
	file     string
	restored bool
}

func LoadSettings(lookup func(string) (string, bool)) (Settings, error) {
	if lookup == nil {
		return Settings{}, ErrUnavailable
	}
	file, enabled := lookup("INTEGRATION_KEYRING_FILE")
	mode, explicit := lookup("INTEGRATION_KEYRING_MODE")
	if !enabled {
		if explicit {
			return Settings{}, ErrUnavailable
		}
		return Settings{}, nil
	}
	if file == "" || len(file) > 4096 || !filepath.IsAbs(file) || filepath.Clean(file) != file ||
		strings.TrimSpace(file) != file || strings.IndexFunc(file, unicode.IsControl) >= 0 {
		return Settings{}, ErrUnavailable
	}
	if explicit && mode != "normal" && mode != "restored" {
		return Settings{}, ErrUnavailable
	}
	return Settings{&settingsState{file, mode == "restored"}}, nil
}
func (s Settings) Enabled() bool                { return s.state != nil }
func (s Settings) Restored() bool               { return s.state != nil && s.state.restored }
func (s Settings) String() string               { return "[redacted integration key settings]" }
func (s Settings) Format(f fmt.State, _ rune)   { _, _ = io.WriteString(f, s.String()) }
func (s Settings) LogValue() slog.Value         { return slog.StringValue(s.String()) }
func (s Settings) MarshalJSON() ([]byte, error) { return nil, ErrUnavailable }
