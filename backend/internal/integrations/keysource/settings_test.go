package keysource

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func env(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) { value, ok := values[name]; return value, ok }
}
func TestSettingsDisableDefaultAndValidateExplicitConfiguration(t *testing.T) {
	s, e := LoadSettings(env(nil))
	if e != nil || s.Enabled() {
		t.Fatal("default did not disable keys")
	}
	for _, mode := range []string{"normal", "restored"} {
		s, e := LoadSettings(env(map[string]string{"INTEGRATION_KEYRING_FILE": "/run/protected/synthetic-keyring.json", "INTEGRATION_KEYRING_MODE": mode}))
		if e != nil || !s.Enabled() || s.Restored() != (mode == "restored") {
			t.Fatal("valid explicit mode rejected")
		}
	}
	for _, values := range []map[string]string{
		{"INTEGRATION_KEYRING_FILE": ""}, {"INTEGRATION_KEYRING_FILE": "relative.json"},
		{"INTEGRATION_KEYRING_FILE": "/run/../private"}, {"INTEGRATION_KEYRING_FILE": "/private\nvalue"},
		{"INTEGRATION_KEYRING_FILE": "/" + strings.Repeat("x", 4096)}, {"INTEGRATION_KEYRING_MODE": "restored"},
		{"INTEGRATION_KEYRING_FILE": "/private", "INTEGRATION_KEYRING_MODE": ""},
		{"INTEGRATION_KEYRING_FILE": "/private", "INTEGRATION_KEYRING_MODE": "unknown"},
	} {
		if s, e := LoadSettings(env(values)); e != ErrUnavailable || s.Enabled() {
			t.Fatal("invalid settings accepted")
		}
	}
	if _, e := LoadSettings(nil); e != ErrUnavailable {
		t.Fatal("nil environment accepted")
	}
}
func TestSettingsFormattingAndJSONRedactPaths(t *testing.T) {
	private := "/run/synthetic-private-mount-location"
	s, e := LoadSettings(env(map[string]string{"INTEGRATION_KEYRING_FILE": private}))
	if e != nil {
		t.Fatal(e)
	}
	for _, format := range []string{"%v", "%+v", "%#v", "%s", "%d"} {
		if strings.Contains(fmt.Sprintf(format, s), private) {
			t.Fatal("settings formatter exposed path")
		}
	}
	var output bytes.Buffer
	slog.New(slog.NewJSONHandler(&output, nil)).Info("test", "settings", s)
	if strings.Contains(output.String(), private) {
		t.Fatal("settings logging exposed path")
	}
	if raw, e := json.Marshal(s); e == nil || bytes.Contains(raw, []byte(private)) || strings.Contains(e.Error(), private) {
		t.Fatal("settings JSON exposed path")
	}
}
