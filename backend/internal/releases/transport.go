package releases

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const bodyLimit = 2 << 20

// Transport is injected in tests. Production uses TLS-verified standard HTTP;
// automatic redirects are refused. Registry blobs allow one explicit hop to
// GitHub's approved CDN without credentials; their content digest is verified.
type Transport interface {
	RoundTrip(*http.Request) (*http.Response, error)
}

type remote struct {
	client *http.Client
	config EvidenceConfig
}

func newRemote(config EvidenceConfig, transport Transport) remote {
	if transport == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 2 * time.Second
		t.TLSHandshakeTimeout = 2 * time.Second
		t.MaxConnsPerHost = 4
		transport = t
	}
	return remote{config: config, client: &http.Client{Transport: transport, Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// All paths are constructed from validated configuration, revisions or digests.
// Caller query values never select a source. The sole permitted remote URL is
// the validated, credential-free registry blob CDN hop below.
func (c remote) get(ctx context.Context, host, path, bearer string) ([]byte, http.Header, string) {
	auth := ""
	if bearer != "" {
		auth = "Bearer " + bearer
	}
	return c.getAuthorized(ctx, host, path, auth)
}

func (c remote) getAuthorized(ctx context.Context, host, path, auth string) ([]byte, http.Header, string) {
	if host != "api.github.com" && host != "ghcr.io" && host != "pkg-containers.githubusercontent.com" {
		return nil, nil, "invalid_evidence"
	}
	if host == "pkg-containers.githubusercontent.com" && auth != "" {
		return nil, nil, "invalid_evidence"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+path, nil)
	if err != nil {
		return nil, nil, "invalid_evidence"
	}
	req.Header.Set("User-Agent", "Roisey-Else-Release-Evidence/1")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if host == "api.github.com" {
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	} else {
		req.Header.Set("Accept", "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/json")
	}
	response, err := c.client.Do(req)
	if err != nil {
		// Never return or log an upstream error (including URL/header details).
		var timeout net.Error
		if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
			return nil, nil, "timeout"
		}
		return nil, nil, "source_unreachable"
	}
	defer response.Body.Close()
	if (response.StatusCode == 307 || response.StatusCode == 302) && host == "ghcr.io" && strings.HasPrefix(path, "/v2/"+c.config.repository+"/blobs/sha256:") {
		location := response.Header.Get("Location")
		u, parseErr := url.Parse(location)
		if parseErr != nil || len(location) > 8192 || u.Scheme != "https" || u.Hostname() != "pkg-containers.githubusercontent.com" || (u.Port() != "" && u.Port() != "443") || u.User != nil || u.Fragment != "" {
			return nil, nil, "invalid_evidence"
		}
		// GHCR serves blobs through one approved CDN. Construct a fresh GET with
		// no credential headers; permit one hop only, and verify content digest.
		return c.getAuthorized(ctx, "pkg-containers.githubusercontent.com", u.RequestURI(), "")
	}
	if response.StatusCode != http.StatusOK {
		reason := "source_unreachable"
		switch response.StatusCode {
		case 401:
			reason = "authentication_failed"
		case 403:
			reason = "access_denied"
			if response.Header.Get("X-RateLimit-Remaining") == "0" || response.Header.Get("Retry-After") != "" {
				reason = "rate_limited"
			}
		case 404:
			reason = "not_found"
		case 429:
			reason = "rate_limited"
		}
		return nil, response.Header, reason
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, bodyLimit+1))
	if err != nil || len(data) > bodyLimit {
		return nil, nil, "invalid_evidence"
	}
	return data, response.Header, ""
}

func (c remote) github(ctx context.Context, path string, value any) string {
	data, _, reason := c.get(ctx, "api.github.com", path, c.config.token)
	if reason != "" {
		return reason
	}
	if json.Unmarshal(data, value) != nil {
		return "invalid_evidence"
	}
	return ""
}

func cleanTimestamp(value string) string {
	if len(value) > 35 || !strings.HasSuffix(value, "Z") {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || t.Year() < 2000 {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
