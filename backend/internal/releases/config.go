package releases

import (
	"regexp"
	"strings"
)

var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$`)
var revisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// EvidenceConfig is deliberately private: formatting configuration cannot print a token.
type EvidenceConfig struct {
	repository string
	token      string
	reason     string
}

func (c EvidenceConfig) String() string   { return "release evidence configuration" }
func (c EvidenceConfig) GoString() string { return c.String() }

// LoadEvidenceConfig never fails application startup for this optional integration.
// Invalid values are not included in diagnostics or observation reports.
func LoadEvidenceConfig(lookup func(string) (string, bool)) EvidenceConfig {
	repository, _ := lookup("GITHUB_REPOSITORY")
	token, _ := lookup("GITHUB_TOKEN")
	if repository == "" || token == "" {
		return EvidenceConfig{reason: "not_configured"}
	}
	if !repositoryPattern.MatchString(repository) || strings.HasSuffix(strings.ToLower(repository), ".git") || strings.Contains(repository, "..") {
		return EvidenceConfig{reason: "invalid_configuration"}
	}
	if len(token) > 4096 || strings.IndexFunc(token, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return EvidenceConfig{reason: "invalid_configuration"}
	}
	return EvidenceConfig{repository: strings.ToLower(repository), token: token}
}

func validRevision(value string) bool {
	return revisionPattern.MatchString(value) && value != strings.Repeat("0", 40)
}
