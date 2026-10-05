package releases

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/theroisey/else/backend/internal/buildinfo"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
func configuration(repository, token string) EvidenceConfig {
	return LoadEvidenceConfig(func(k string) (string, bool) {
		if k == "GITHUB_REPOSITORY" {
			return repository, true
		}
		return token, true
	})
}
func TestConfigurationValidationAndRedaction(t *testing.T) {
	for _, v := range []string{"https://github.com/a/b", "a", "a/b/c", "a/b?source=x", "a/b.git", "a/..", "a/b\n", "-a/b", "a /b", "a/%2f"} {
		c := configuration(v, "token-secret")
		if c.reason != "invalid_configuration" || c.token != "" || c.repository != "" {
			t.Fatal("unsafe repository accepted")
		}
	}
	for _, v := range []string{"token\nsecret", "token secret", strings.Repeat("a", 4097)} {
		if configuration("Owner/repository", v).reason != "invalid_configuration" {
			t.Fatal("unsafe token accepted")
		}
	}
	c := configuration("Owner/repository", "github_pat_secret")
	if c.repository != "owner/repository" || strings.Contains(fmt.Sprintf("%v %+v %#v", c, c, c), "secret") {
		t.Fatal("config leaked or normalization failed")
	}
}

type fixture struct {
	mu                                        sync.Mutex
	calls                                     map[string]int
	manifest, config, digest, revision, stamp string
	mutate                                    func(*http.Request, *http.Response) *http.Response
}

func newFixture() *fixture {
	f := &fixture{calls: make(map[string]int), revision: strings.Repeat("a", 40), stamp: "2026-10-05T12:00:00Z"}
	f.config = fmt.Sprintf(`{"config":{"Labels":{"org.opencontainers.image.source":"https://github.com/owner/repository","org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"sha-%s","org.opencontainers.image.created":"%s"}}}`, f.revision, f.revision, f.stamp)
	f.rehash()
	return f
}
func (f *fixture) rehash() {
	f.manifest = fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"digest":"%s","size":%d}}`, contentDigest([]byte(f.config)), len(f.config))
	f.digest = contentDigest([]byte(f.manifest))
}
func (f *fixture) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || (r.URL.Host != "api.github.com" && r.URL.Host != "ghcr.io") {
		panic("unsafe outbound request")
	}
	if r.URL.Host == "api.github.com" && (r.Header.Get("Authorization") != "Bearer github_pat_secret" || r.Header.Get("X-GitHub-Api-Version") == "" || r.Header.Get("User-Agent") == "") {
		panic("missing API contract")
	}
	if r.URL.Host == "ghcr.io" && strings.Contains(r.Header.Get("Authorization"), "github_pat_secret") {
		panic("PAT sent to public GHCR")
	}
	f.mu.Lock()
	f.calls[r.URL.RequestURI()]++
	f.mu.Unlock()
	p := response(404, `{"message":"github_pat_secret"}`)
	switch {
	case r.URL.Path == "/repos/owner/repository":
		p = response(200, `{"full_name":"Owner/Repository"}`)
	case r.URL.Path == "/token":
		p = response(200, `{"token":"registry-secret"}`)
	case strings.Contains(r.URL.Path, "/manifests/"):
		p = response(200, f.manifest)
		p.Header.Set("Docker-Content-Digest", f.digest)
	case strings.Contains(r.URL.Path, "/blobs/"):
		p = response(200, f.config)
	case strings.Contains(r.URL.Path, "/commits/"):
		p = response(200, `{"sha":"`+f.revision+`"}`)
	case strings.Contains(r.URL.Path, "/attestations/"):
		payload := base64.StdEncoding.EncodeToString([]byte(`{"_type":"https://in-toto.io/Statement/v1","predicateType":"https://slsa.dev/provenance/v1","subject":[{"name":"ghcr.io/owner/repository","digest":{"sha256":"` + strings.TrimPrefix(f.digest, "sha256:") + `"}}]}`))
		p = response(200, `{"attestations":[{"bundle":{"dsseEnvelope":{"payloadType":"application/vnd.in-toto+json","payload":"`+payload+`"}}}]}`)
	case strings.HasSuffix(r.URL.Path, "/runs"):
		p = response(200, `{"workflow_runs":[{"id":42,"head_sha":"`+f.revision+`","head_branch":"main","path":".github/workflows/ci.yml","event":"push","conclusion":"success"}]}`)
	case strings.HasSuffix(r.URL.Path, "/jobs"):
		p = response(200, `{"jobs":[{"name":"Publish tested main application image","conclusion":"success","completed_at":"2026-10-05T12:10:00Z"}]}`)
	}
	if f.mutate != nil {
		p = f.mutate(r, p)
	}
	return p, nil
}
func (f *fixture) service() *Service {
	v := "sha-" + f.revision
	return NewEvidenceService(configuration("owner/repository", "github_pat_secret"), buildinfo.Metadata{Status: "available", Version: &v, CommitSHA: &f.revision, BuiltAt: &f.stamp}, f)
}
func TestImmutableEvidenceIsSeparateFromSignatureAndDeployment(t *testing.T) {
	f := newFixture()
	r := f.service().Observe(context.Background(), false)
	if r.LatestRelease.Status != "available" || r.ImageProvenance.Status != "available" || r.Deployment.Status != "unavailable" || r.LatestRelease.Artifact.Digest != f.digest || r.ImageProvenance.Artifact.PublishedAt == nil || r.ImageProvenance.Attestation.Status != "present" || r.ImageProvenance.Attestation.Reason != "signature_not_verified" {
		t.Fatalf("incorrect evidence %+v", r)
	}
	for path, count := range f.calls {
		if count != 1 {
			t.Fatalf("duplicate request %s", path)
		}
	}
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "secret") {
		t.Fatal("secret escaped")
	}
}
func TestMissingConfigurationMakesNoOutboundRequest(t *testing.T) {
	s := NewEvidenceService(configuration("owner/repository", ""), buildinfo.Metadata{}, transportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("outbound request"); return nil, nil }))
	if s.Observe(context.Background(), true).LatestRelease.Reason != "not_configured" {
		t.Fatal("missing config misclassified")
	}
}
func TestRemoteFailureClassificationAndBounds(t *testing.T) {
	for _, test := range []struct {
		status int
		reason string
	}{{401, "authentication_failed"}, {403, "access_denied"}, {429, "rate_limited"}, {404, "not_found"}, {500, "source_unreachable"}, {302, "source_unreachable"}} {
		t.Run(test.reason+fmt.Sprint(test.status), func(t *testing.T) {
			f := newFixture()
			f.mutate = func(*http.Request, *http.Response) *http.Response {
				return response(test.status, `{"message":"github_pat_secret"}`)
			}
			r := f.service().Observe(context.Background(), false)
			if r.LatestRelease.Reason != test.reason {
				t.Fatalf("classification %s", r.LatestRelease.Reason)
			}
			b, _ := json.Marshal(r)
			if strings.Contains(string(b), "secret") {
				t.Fatal("upstream body leaked")
			}
		})
	}
	for _, body := range []string{`not json`, `{"full_name":"other/repository"}`, strings.Repeat("a", bodyLimit+1)} {
		f := newFixture()
		f.mutate = func(*http.Request, *http.Response) *http.Response { return response(200, body) }
		if f.service().Observe(context.Background(), false).LatestRelease.Status != "unavailable" {
			t.Fatal("malformed evidence accepted")
		}
	}
	f := newFixture()
	f.mutate = func(*http.Request, *http.Response) *http.Response {
		p := response(403, "private")
		p.Header.Set("X-RateLimit-Remaining", "0")
		return p
	}
	if f.service().Observe(context.Background(), true).LatestRelease.Reason != "rate_limited" {
		t.Fatal("rate limit not detected")
	}
}
func TestDigestRevisionSourceAndBuildMismatch(t *testing.T) {
	for _, field := range []string{"digest", "revision", "source", "version", "built_at", "immutable"} {
		t.Run(field, func(t *testing.T) {
			f := newFixture()
			s := f.service()
			switch field {
			case "revision":
				f.config = strings.ReplaceAll(f.config, f.revision, strings.Repeat("b", 40))
				f.rehash()
			case "source":
				f.config = strings.ReplaceAll(f.config, "https://github.com/owner/repository", "https://evil.example")
				f.rehash()
			case "version":
				f.config = strings.ReplaceAll(f.config, "sha-"+f.revision, "v1.2.3")
				f.rehash()
			case "built_at":
				f.config = strings.ReplaceAll(f.config, f.stamp, "2026-10-05T13:00:00Z")
				f.rehash()
			case "digest":
				f.mutate = func(r *http.Request, p *http.Response) *http.Response {
					if strings.Contains(r.URL.Path, "/manifests/") {
						p.Header.Set("Docker-Content-Digest", "sha256:"+strings.Repeat("b", 64))
					}
					return p
				}
			case "immutable":
				f.mutate = func(r *http.Request, p *http.Response) *http.Response {
					if strings.Contains(r.URL.Path, "/manifests/sha-") {
						return response(404, "private")
					}
					return p
				}
			}
			if s.Observe(context.Background(), false).ImageProvenance.Status != "unavailable" {
				t.Fatal("unmatched image accepted")
			}
		})
	}
}
func TestCacheRefreshCoalescingAndBackoff(t *testing.T) {
	f := newFixture()
	s := f.service()
	now := time.Now()
	s.now = func() time.Time { return now }
	s.Observe(context.Background(), false)
	s.Observe(context.Background(), true)
	if f.calls["/repos/owner/repository"] != 1 {
		t.Fatal("refresh bypassed floor")
	}
	now = now.Add(11 * time.Second)
	var wait sync.WaitGroup
	for range 20 {
		wait.Add(1)
		go func() { defer wait.Done(); s.Observe(context.Background(), true) }()
	}
	wait.Wait()
	if f.calls["/repos/owner/repository"] != 2 {
		t.Fatal("refresh not coalesced")
	}
	now = now.Add(time.Minute)
	s.Observe(context.Background(), false)
	if f.calls["/repos/owner/repository"] != 3 {
		t.Fatal("TTL failed")
	}
	f.mutate = func(*http.Request, *http.Response) *http.Response { return response(429, "private") }
	now = now.Add(time.Minute)
	s.Observe(context.Background(), true)
	now = now.Add(time.Minute)
	s.Observe(context.Background(), true)
	if f.calls["/repos/owner/repository"] != 4 {
		t.Fatal("backoff failed")
	}
}
func TestCancellationAndWaiting(t *testing.T) {
	started := make(chan struct{})
	transport := transportFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		return nil, fmt.Errorf("github_pat_secret: %w", r.Context().Err())
	})
	s := NewEvidenceService(configuration("owner/repository", "github_pat_secret"), buildinfo.Metadata{}, transport)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan Evidence, 1)
	go func() { result <- s.Observe(ctx, false) }()
	<-started
	waitCtx, done := context.WithCancel(context.Background())
	done()
	if s.Observe(waitCtx, true).LatestRelease.Reason != "timeout" {
		t.Fatal("wait not cancellable")
	}
	cancel()
	if (<-result).LatestRelease.Reason != "timeout" {
		t.Fatal("cancel classification")
	}
}
func TestPrivateFinePATAndPartialAttestation(t *testing.T) {
	f := newFixture()
	f.mutate = func(r *http.Request, p *http.Response) *http.Response {
		if r.URL.Path == "/token" {
			return response(403, "github_pat_secret")
		}
		return p
	}
	if f.service().Observe(context.Background(), false).LatestRelease.Reason != "package_token_unsupported" {
		t.Fatal("fine PAT used for private packages")
	}
	for _, status := range []int{401, 403, 404, 500} {
		f = newFixture()
		f.mutate = func(r *http.Request, p *http.Response) *http.Response {
			if strings.Contains(r.URL.Path, "/attestations/") {
				return response(status, "github_pat_secret")
			}
			return p
		}
		r := f.service().Observe(context.Background(), false)
		if r.ImageProvenance.Status != "available" || r.ImageProvenance.Attestation.Status != "unavailable" {
			t.Fatal("partial evidence discarded or signature invented")
		}
	}
}

func TestRegistryBlobRedirectBoundary(t *testing.T) {
	for _, location := range []string{"https://pkg-containers.githubusercontent.com/blob?signature=synthetic", "https://attacker.example/blob", "http://pkg-containers.githubusercontent.com/blob", "https://secret@pkg-containers.githubusercontent.com/blob", "https://pkg-containers.githubusercontent.com:444/blob"} {
		t.Run(location, func(t *testing.T) {
			calls := 0
			transport := transportFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					if r.URL.Host != "ghcr.io" || r.Header.Get("Authorization") != "Bearer registry-secret" {
						t.Fatal("incorrect registry request")
					}
					p := response(307, "")
					p.Header.Set("Location", location)
					return p, nil
				}
				if r.URL.Host != "pkg-containers.githubusercontent.com" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Fatal("credential followed redirect")
				}
				return response(200, "synthetic config"), nil
			})
			c := newRemote(configuration("owner/repository", "github_pat_secret"), transport)
			body, _, reason := c.get(context.Background(), "ghcr.io", "/v2/owner/repository/blobs/sha256:"+strings.Repeat("a", 64), "registry-secret")
			if location == "https://pkg-containers.githubusercontent.com/blob?signature=synthetic" {
				if reason != "" || string(body) != "synthetic config" || calls != 2 {
					t.Fatal("approved credential-free CDN failed")
				}
			} else if reason != "invalid_evidence" || calls != 1 {
				t.Fatal("unsafe redirect followed")
			}
		})
	}
}

func TestNewerLatestArtifactKeepsIndependentRunningProvenance(t *testing.T) {
	f := newFixture()
	latest := newFixture()
	latest.revision = strings.Repeat("b", 40)
	latest.config = strings.ReplaceAll(latest.config, f.revision, latest.revision)
	latest.rehash()
	f.mutate = func(r *http.Request, p *http.Response) *http.Response {
		if strings.HasSuffix(r.URL.Path, "/manifests/latest") || strings.HasSuffix(r.URL.Path, "/manifests/sha-"+latest.revision) {
			p = response(200, latest.manifest)
			p.Header.Set("Docker-Content-Digest", latest.digest)
			return p
		}
		if strings.HasSuffix(r.URL.Path, "/blobs/"+contentDigest([]byte(latest.config))) {
			return response(200, latest.config)
		}
		if strings.HasSuffix(r.URL.Path, "/commits/"+latest.revision) {
			return response(200, `{"sha":"`+latest.revision+`"}`)
		}
		return p
	}
	for n := 0; n < 10; n++ {
		evidence := f.service().Observe(context.Background(), false)
		if evidence.LatestRelease.Status != "available" || evidence.ImageProvenance.Status != "available" || evidence.LatestRelease.Artifact.CommitSHA != latest.revision || evidence.ImageProvenance.Artifact.CommitSHA != f.revision || evidence.ImageProvenance.Attestation.Status != "present" {
			t.Fatal("latest publication replaced independent running evidence")
		}
	}
}
