package buildinfo

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompleteStampAndUnavailableRedaction(t *testing.T) {
	r := strings.Repeat("a", 40)
	v, b := "sha-"+r, "2026-10-03T18:00:00Z"
	valid := validated(v, r, b)
	if valid.Status != "available" || *valid.Version != v || *valid.CommitSHA != r || *valid.BuiltAt != b {
		t.Fatal("valid stamp refused")
	}
	for _, tc := range [][3]string{
		{"", "", ""}, {v, r, ""}, {"", r, b}, {v, "", b},
		{"synthetic-private-value", r, b}, {v, strings.ToUpper(r), b}, {v, r, "2026-10-03T18:00:00+00:00"},
		{v, r, "2026-02-30T18:00:00Z"}, {v, r, "2026-10-03T18:00:00.000Z"}, {v, r, "1999-01-01T00:00:00Z"},
		{"sha-" + strings.Repeat("0", 40), strings.Repeat("0", 40), b},
	} {
		m := validated(tc[0], tc[1], tc[2])
		data, e := json.Marshal(m)
		if e != nil || string(data) != `{"status":"unavailable","version":null,"commit_sha":null,"built_at":null}` {
			t.Fatal("partial/invalid stamp exposed inputs")
		}
	}
}

func TestRuntimeVariablesCannotOverrideCompiledStamp(t *testing.T) {
	t.Setenv("BUILD_VERSION", "synthetic-private-value")
	t.Setenv("BUILD_REVISION", strings.Repeat("b", 40))
	t.Setenv("BUILD_TIME", "2026-10-03T18:00:00Z")
	if Current() != (Metadata{Status: "unavailable"}) {
		t.Fatal("runtime environment replaced unstamped binary")
	}
}
