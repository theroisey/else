// Package releases provides current binary metadata under fresh global grants.
// Remote release, image provenance and deployment observations are unavailable
// until an authenticated authoritative source is separately implemented.
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

type Observation struct {
	Status string `json:"status"`
}
type Report struct {
	Runtime         buildinfo.Metadata `json:"runtime"`
	LatestRelease   Observation        `json:"latest_release"`
	ImageProvenance Observation        `json:"image_provenance"`
	Deployment      Observation        `json:"deployment"`
}

type Handler struct {
	auth       *identity.Handler
	authorizer *authorization.Service
	logger     *slog.Logger
	metadata   buildinfo.Metadata
}

func NewHandler(auth *identity.Handler, authorizer *authorization.Service, logger *slog.Logger) (*Handler, error) {
	if auth == nil || authorizer == nil || logger == nil {
		return nil, ErrInvalid
	}
	return &Handler{auth, authorizer, logger, buildinfo.Current()}, nil
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
	u := Observation{Status: "unavailable"}
	httpapi.WriteJSON(w, r, 200, struct {
		Data Report `json:"data"`
	}{Report{h.metadata, u, u, u}})
}
