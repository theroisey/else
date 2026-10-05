package releases

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
)

type imageManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	MediaType     string `json:"mediaType"`
	Config        struct {
		Digest string `json:"digest"`
		Size   int64  `json:"size"`
	} `json:"config"`
}

type imageConfig struct {
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"config"`
}

func contentDigest(data []byte) string {
	hash := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(hash[:])
}

func (c remote) registryToken(ctx context.Context) (string, string) {
	path := "/token?service=ghcr.io&scope=" + url.QueryEscape("repository:"+c.config.repository+":pull")
	data, _, reason := c.get(ctx, "ghcr.io", path, "")
	if reason == "authentication_failed" || reason == "access_denied" {
		// A fine-grained PAT is not a GHCR credential. Do not retry it there.
		if strings.HasPrefix(c.config.token, "github_pat_") {
			return "", "package_token_unsupported"
		}
		var user struct {
			Login string `json:"login"`
		}
		if why := c.github(ctx, "/user", &user); why != "" {
			return "", why
		}
		if !regexpLogin(user.Login) {
			return "", "invalid_evidence"
		}
		auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(user.Login+":"+c.config.token))
		data, _, reason = c.getAuthorized(ctx, "ghcr.io", path, auth)
	}
	if reason != "" {
		return "", reason
	}
	var response struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(data, &response) != nil || len(response.Token) < 1 || len(response.Token) > 16384 || strings.IndexFunc(response.Token, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return "", "invalid_evidence"
	}
	return response.Token, ""
}

func regexpLogin(value string) bool {
	return repositoryPattern.MatchString(value + "/repository")
}

func (c remote) manifest(ctx context.Context, token, reference string) ([]byte, imageManifest, string) {
	data, headers, reason := c.get(ctx, "ghcr.io", "/v2/"+c.config.repository+"/manifests/"+reference, token)
	var manifest imageManifest
	if reason != "" {
		return nil, manifest, reason
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.SchemaVersion != 2 || !digestPattern.MatchString(manifest.Config.Digest) || manifest.Config.Size < 1 || manifest.Config.Size > bodyLimit ||
		(manifest.MediaType != "application/vnd.oci.image.manifest.v1+json" && manifest.MediaType != "application/vnd.docker.distribution.manifest.v2+json") {
		return nil, manifest, "invalid_evidence"
	}
	digest := headers.Get("Docker-Content-Digest")
	if !digestPattern.MatchString(digest) || digest != contentDigest(data) {
		return nil, manifest, "digest_mismatch"
	}
	return data, manifest, ""
}

func (c remote) image(ctx context.Context, token, reference, expected string) Observation {
	data, manifest, reason := c.manifest(ctx, token, reference)
	if reason != "" {
		return unavailable(reason)
	}
	digest := contentDigest(data)
	configData, _, reason := c.get(ctx, "ghcr.io", "/v2/"+c.config.repository+"/blobs/"+manifest.Config.Digest, token)
	if reason != "" {
		return unavailable(reason)
	}
	if int64(len(configData)) != manifest.Config.Size || contentDigest(configData) != manifest.Config.Digest {
		return unavailable("digest_mismatch")
	}
	var config imageConfig
	if json.Unmarshal(configData, &config) != nil {
		return unavailable("invalid_evidence")
	}
	labels := config.Config.Labels
	revision := labels["org.opencontainers.image.revision"]
	if !validRevision(revision) || (expected != "" && revision != expected) {
		return unavailable("revision_mismatch")
	}
	// Source and version labels were added in #132. Historical artifacts lacking
	// these labels remain partial rather than receiving invented provenance.
	if labels["org.opencontainers.image.source"] != "https://github.com/"+c.config.repository || labels["org.opencontainers.image.version"] != "sha-"+revision {
		return unavailable("metadata_incomplete")
	}
	builtAt := cleanTimestamp(labels["org.opencontainers.image.created"])
	if builtAt == "" {
		return unavailable("invalid_evidence")
	}
	if reference != "sha-"+revision {
		immutable, _, why := c.manifest(ctx, token, "sha-"+revision)
		if why != "" {
			return unavailable(why)
		}
		if contentDigest(immutable) != digest {
			return unavailable("digest_mismatch")
		}
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	if why := c.github(ctx, "/repos/"+c.config.repository+"/commits/"+revision, &commit); why != "" {
		return unavailable(why)
	}
	if commit.SHA != revision {
		return unavailable("revision_mismatch")
	}
	return Observation{Status: "available", Artifact: &Artifact{CommitSHA: revision, Tag: "sha-" + revision,
		ImageReference: "ghcr.io/" + c.config.repository + "@" + digest, Digest: digest, BuiltAt: builtAt, Source: "github_ghcr"}}
}

func (s *Service) collect(ctx context.Context) Evidence {
	if s.remote.config.reason != "" {
		return s.fallback(s.remote.config.reason)
	}
	result := s.fallback("runtime_unidentified")
	var repo struct {
		FullName string `json:"full_name"`
	}
	if why := s.remote.github(ctx, "/repos/"+s.remote.config.repository, &repo); why != "" {
		return s.fallback(why)
	}
	if !strings.EqualFold(repo.FullName, s.remote.config.repository) {
		return s.fallback("repository_mismatch")
	}
	token, why := s.remote.registryToken(ctx)
	if why != "" {
		return s.fallback(why)
	}
	result.LatestRelease = s.remote.image(ctx, token, "latest", "")
	if s.metadata.Status == "available" && s.metadata.CommitSHA != nil && validRevision(*s.metadata.CommitSHA) {
		if a := result.LatestRelease.Artifact; a != nil && a.CommitSHA == *s.metadata.CommitSHA {
			result.ImageProvenance = result.LatestRelease
		} else {
			result.ImageProvenance = s.remote.image(ctx, token, "sha-"+*s.metadata.CommitSHA, *s.metadata.CommitSHA)
		}
		if a := result.ImageProvenance.Artifact; a != nil && (s.metadata.BuiltAt == nil || a.BuiltAt != *s.metadata.BuiltAt || s.metadata.Version == nil || a.Tag != *s.metadata.Version) {
			result.ImageProvenance = unavailable("runtime_metadata_mismatch")
		}
	}
	// The API cannot inspect its enclosing container digest. This is registry
	// evidence matching the binary stamp, never proof of the host's running image.
	var wait sync.WaitGroup
	// Capture the immutable input before publication workers replace observation
	// pointers. Latest and running artifacts can belong to different commits.
	runningArtifact := result.ImageProvenance.Artifact
	observations := []*Observation{&result.LatestRelease, &result.ImageProvenance}
	same := result.LatestRelease.Artifact != nil && result.ImageProvenance.Artifact != nil && result.LatestRelease.Artifact.CommitSHA == result.ImageProvenance.Artifact.CommitSHA
	if same {
		observations = observations[:1]
	}
	for _, observation := range observations {
		if observation.Artifact == nil {
			continue
		}
		wait.Add(1)
		go func(o *Observation) {
			defer wait.Done()
			a := *o.Artifact
			a.PublishedAt = s.remote.publicationTime(ctx, a.CommitSHA)
			o.Artifact = &a
		}(observation)
	}
	if a := runningArtifact; a != nil {
		wait.Add(1)
		go func() { defer wait.Done(); result.ImageProvenance.Attestation = s.remote.attestation(ctx, *a) }()
	}
	wait.Wait()
	if same {
		a := *result.ImageProvenance.Artifact
		a.PublishedAt = result.LatestRelease.Artifact.PublishedAt
		result.ImageProvenance.Artifact = &a
	}
	return result
}
