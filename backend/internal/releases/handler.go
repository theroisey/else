// Package releases provides read-only build and remote evidence under fresh grants.
package releases

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/buildinfo"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

var ErrInvalid = errors.New("invalid release handler")

type Report struct {
	Runtime         buildinfo.Metadata `json:"runtime"`
	LatestRelease   Observation        `json:"latest_release"`
	ImageProvenance Observation        `json:"image_provenance"`
	Deployment      Observation        `json:"deployment"`
	CheckedAt       string             `json:"checked_at,omitempty"`
}

type Handler struct {
	auth       *identity.Handler
	authorizer *authorization.Service
	logger     *slog.Logger
	metadata   buildinfo.Metadata
	provider   EvidenceProvider
}

func NewHandler(auth *identity.Handler, authorizer *authorization.Service, logger *slog.Logger, providers ...EvidenceProvider) (*Handler, error) {
	if auth == nil || authorizer == nil || logger == nil {
		return nil, ErrInvalid
	}
	metadata := buildinfo.Current()
	var provider EvidenceProvider = NewEvidenceService(EvidenceConfig{reason: "not_configured"}, metadata, nil)
	if len(providers) > 1 {
		return nil, ErrInvalid
	}
	if len(providers) == 1 {
		if providers[0] == nil {
			return nil, ErrInvalid
		}
		provider = providers[0]
	}
	return &Handler{auth: auth, authorizer: authorizer, logger: logger, metadata: metadata, provider: provider}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		httpapi.WriteError(w, r, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.URL.Path != "/api/v1/releases" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		httpapi.WriteError(w, r, 400, "invalid_request", "Release request is invalid.")
		return
	}
	allowed, err := h.authorizer.Allowed(r.Context(), session.User.ID, authorization.ReleasesView, "")
	if err != nil {
		h.logger.ErrorContext(r.Context(), "release_read_error", "request_id", httpapi.RequestID(r.Context()), "error_code", "internal_error")
		httpapi.WriteError(w, r, 500, "internal_error", "An internal error occurred.")
		return
	}
	if !allowed {
		httpapi.WriteError(w, r, 403, "permission_denied", "Permission denied.")
		return
	}
	refresh := r.Header.Get("X-Release-Refresh")
	if refresh != "" && refresh != "revalidate" {
		httpapi.WriteError(w, r, 400, "invalid_request", "Release request is invalid.")
		return
	}
	evidence := h.provider.Observe(r.Context(), refresh == "revalidate")
	httpapi.WriteJSON(w, r, 200, struct {
		Data Report `json:"data"`
	}{Report{Runtime: h.metadata, LatestRelease: evidence.LatestRelease, ImageProvenance: evidence.ImageProvenance, Deployment: evidence.Deployment, CheckedAt: evidence.CheckedAt}})
}
