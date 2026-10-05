package releases

import (
	"context"
	"sync"
	"time"

	"github.com/theroisey/else/backend/internal/buildinfo"
)

type Artifact struct {
	CommitSHA      string  `json:"commit_sha"`
	Tag            string  `json:"tag"`
	ImageReference string  `json:"image_reference"`
	Digest         string  `json:"digest"`
	BuiltAt        string  `json:"built_at"`
	PublishedAt    *string `json:"published_at"`
	Source         string  `json:"source"`
}

type Attestation struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

type Observation struct {
	Status      string       `json:"status"`
	Reason      string       `json:"reason,omitempty"`
	Artifact    *Artifact    `json:"artifact,omitempty"`
	Attestation *Attestation `json:"attestation,omitempty"`
}

type Evidence struct {
	LatestRelease   Observation
	ImageProvenance Observation
	Deployment      Observation
	CheckedAt       string
}

type EvidenceProvider interface {
	Observe(context.Context, bool) Evidence
}

// Service caches only sanitized repository evidence, never user/session data.
// Authorization always runs before this cache is consulted. Concurrent readers
// coalesce; a cancelled waiter can leave without waiting for the remote request.
type Service struct {
	remote       remote
	metadata     buildinfo.Metadata
	mu           sync.Mutex
	cached       Evidence
	expires      time.Time
	refreshAfter time.Time
	inflight     chan struct{}
	now          func() time.Time
}

func NewEvidenceService(config EvidenceConfig, metadata buildinfo.Metadata, transport Transport) *Service {
	return &Service{remote: newRemote(config, transport), metadata: metadata, now: time.Now}
}

func unavailable(reason string) Observation {
	return Observation{Status: "unavailable", Reason: reason}
}

func (s *Service) fallback(reason string) Evidence {
	return Evidence{LatestRelease: unavailable(reason), ImageProvenance: unavailable(reason),
		Deployment: unavailable("deployment_source_not_connected"), CheckedAt: s.now().UTC().Format(time.RFC3339)}
}

func (s *Service) Observe(ctx context.Context, refresh bool) Evidence {
	for {
		s.mu.Lock()
		now := s.now()
		if now.Before(s.expires) && (!refresh || now.Before(s.refreshAfter)) {
			result := s.cached
			s.mu.Unlock()
			return result
		}
		if active := s.inflight; active != nil {
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return s.fallback("timeout")
			case <-active:
				refresh = false
				continue
			}
		}
		s.inflight = make(chan struct{})
		s.mu.Unlock()
		// Fit inside the existing five-second application request budget.
		bounded, cancel := context.WithTimeout(ctx, 4*time.Second)
		result := s.collect(bounded)
		cancel()
		s.mu.Lock()
		s.cached = result
		s.expires = s.now().Add(time.Minute)
		s.refreshAfter = s.now().Add(10 * time.Second)
		// Rate limits receive a conservative backoff, including manual refresh.
		if result.LatestRelease.Reason == "rate_limited" || result.ImageProvenance.Reason == "rate_limited" {
			s.expires = s.now().Add(5 * time.Minute)
			s.refreshAfter = s.expires
		}
		close(s.inflight)
		s.inflight = nil
		s.mu.Unlock()
		return result
	}
}
