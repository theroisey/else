// Package buildinfo exposes a validated immutable build stamp. It never reads
// deployment configuration or claims release, registry or rollout verification.
package buildinfo

import (
	"regexp"
	"time"
)

// Set together by the reviewed build helper using Go linker -X inputs.
var version, revision, builtAt string

var commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

type Metadata struct {
	Status    string  `json:"status"`
	Version   *string `json:"version"`
	CommitSHA *string `json:"commit_sha"`
	BuiltAt   *string `json:"built_at"`
}

func Current() Metadata { return validated(version, revision, builtAt) }

func validated(v, r, b string) Metadata {
	unavailable := Metadata{Status: "unavailable"}
	if !commitPattern.MatchString(r) || r == "0000000000000000000000000000000000000000" || v != "sha-"+r || len(b) != 20 {
		return unavailable
	}
	t, err := time.Parse(time.RFC3339, b)
	if err != nil || t.Format("2006-01-02T15:04:05Z") != b || t.Year() < 2000 {
		return unavailable
	}
	return Metadata{Status: "available", Version: &v, CommitSHA: &r, BuiltAt: &b}
}
