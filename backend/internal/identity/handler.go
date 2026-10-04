package identity

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"time"

	"github.com/theroisey/else/backend/internal/config"
	httpapi "github.com/theroisey/else/backend/internal/http"
)

const maxLoginBody = 4096

type Handler struct {
	service *Service
	config  config.Auth
	logger  *slog.Logger
	limiter *loginLimiter
}

func NewHandler(service *Service, c config.Auth, logger *slog.Logger) (*Handler, error) {
	if service == nil || logger == nil {
		return nil, ErrInvalidInput
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &Handler{service: service, config: c, logger: logger, limiter: newLoginLimiter()}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/v1/auth/login":
		h.login(w, r)
	case "/api/v1/auth/logout":
		h.logout(w, r)
	case "/api/v1/auth/session":
		h.current(w, r)
	default:
		httpapi.WriteError(w, r, http.StatusNotFound, "not_found", "Resource not found.")
	}
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if !h.requireMethod(w, r, http.MethodPost) || !h.requireUnsafe(w, r) {
		return
	}
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	email, _ := canonicalEmail(input.Email)
	if !h.limiter.allow(directPeer(r.RemoteAddr), email) {
		h.logger.WarnContext(r.Context(), "authentication_rate_limited", "request_id", httpapi.RequestID(r.Context()))
		w.Header().Set("Retry-After", "900")
		httpapi.WriteError(w, r, http.StatusTooManyRequests, "authentication_rate_limited", "Authentication is temporarily unavailable.")
		return
	}
	result, err := h.service.Login(r.Context(), input.Email, input.Password)
	if err != nil {
		if errors.Is(err, ErrPasswordWorkUnavailable) {
			h.logger.WarnContext(r.Context(), "authentication_busy", "request_id", httpapi.RequestID(r.Context()))
			w.Header().Set("Retry-After", "1")
			httpapi.WriteError(w, r, http.StatusServiceUnavailable, "service_busy", "This operation is temporarily unavailable. Try again.")
			return
		}
		if errors.Is(err, ErrInvalidCredentials) {
			h.logger.WarnContext(r.Context(), "authentication_failed", "request_id", httpapi.RequestID(r.Context()))
			httpapi.WriteError(w, r, http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect.")
			return
		}
		h.logger.ErrorContext(r.Context(), "authentication_error", "request_id", httpapi.RequestID(r.Context()), "error_code", "authentication_error")
		httpapi.WriteError(w, r, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
		return
	}
	h.setCookies(w, result)
	httpapi.WriteJSON(w, r, http.StatusOK, sessionResponse(result.Session))
}

func (h *Handler) current(w http.ResponseWriter, r *http.Request) {
	if !h.requireMethod(w, r, http.MethodGet) {
		return
	}
	session, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	httpapi.WriteJSON(w, r, http.StatusOK, sessionResponse(session))
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if !h.requireMethod(w, r, http.MethodPost) || !h.requireUnsafe(w, r) {
		return
	}
	session, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	csrf, err := r.Cookie(h.csrfCookieName())
	if err != nil || !h.service.ValidCSRF(session, csrf.Value, r.Header.Get("X-CSRF-Token")) {
		h.logger.WarnContext(r.Context(), "authentication_csrf_failed", "request_id", httpapi.RequestID(r.Context()))
		httpapi.WriteError(w, r, http.StatusForbidden, "csrf_failed", "Request verification failed.")
		return
	}
	if err := h.service.Logout(r.Context(), session); err != nil {
		h.logger.ErrorContext(r.Context(), "authentication_logout_error", "request_id", httpapi.RequestID(r.Context()), "error_code", "authentication_error")
		httpapi.WriteError(w, r, http.StatusInternalServerError, "internal_error", "An internal error occurred.")
		return
	}
	h.clearCookies(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) authenticate(w http.ResponseWriter, r *http.Request) (Session, bool) {
	cookie, err := r.Cookie(h.sessionCookieName())
	if err != nil {
		httpapi.WriteError(w, r, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return Session{}, false
	}
	session, err := h.service.Current(r.Context(), cookie.Value)
	if err != nil {
		h.clearCookies(w)
		httpapi.WriteError(w, r, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return Session{}, false
	}
	return session, true
}

// AuthenticateRequest shares the existing cookie/current-identity boundary
// with protected domains. Actor identity never comes from request JSON.
func (h *Handler) AuthenticateRequest(w http.ResponseWriter, r *http.Request) (Session, bool) {
	return h.authenticate(w, r)
}

// VerifyMutation requires the exact public Origin, JSON, and session-bound CSRF.
func (h *Handler) VerifyMutation(w http.ResponseWriter, r *http.Request, session Session) bool {
	if !h.requireUnsafe(w, r) {
		return false
	}
	cookie, err := r.Cookie(h.csrfCookieName())
	if err != nil || !h.service.ValidCSRF(session, cookie.Value, r.Header.Get("X-CSRF-Token")) {
		httpapi.WriteError(w, r, http.StatusForbidden, "csrf_failed", "Request verification failed.")
		return false
	}
	return true
}

func (h *Handler) requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	httpapi.WriteError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
	return false
}

func (h *Handler) requireUnsafe(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Origin") != h.config.PublicOrigin {
		httpapi.WriteError(w, r, http.StatusForbidden, "origin_forbidden", "Request origin is not allowed.")
		return false
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		httpapi.WriteError(w, r, http.StatusUnsupportedMediaType, "content_type_required", "Content-Type must be application/json.")
		return false
	}
	return true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		httpapi.WriteError(w, r, http.StatusBadRequest, "invalid_request", "Request body is invalid.")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		httpapi.WriteError(w, r, http.StatusBadRequest, "invalid_request", "Request body is invalid.")
		return false
	}
	return true
}

func directPeer(remote string) string {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return "unknown"
	}
	return host
}

func sessionResponse(session Session) any {
	return struct {
		Data struct {
			User    User `json:"user"`
			Session struct {
				ExpiresAt time.Time `json:"expires_at"`
			} `json:"session"`
		} `json:"data"`
	}{Data: struct {
		User    User `json:"user"`
		Session struct {
			ExpiresAt time.Time `json:"expires_at"`
		} `json:"session"`
	}{User: session.User, Session: struct {
		ExpiresAt time.Time `json:"expires_at"`
	}{ExpiresAt: session.ExpiresAt}}}
}

func (h *Handler) sessionCookieName() string {
	if h.config.CookieSecure {
		return "__Host-else_session"
	}
	return "else_session"
}
func (h *Handler) csrfCookieName() string {
	if h.config.CookieSecure {
		return "__Host-else_csrf"
	}
	return "else_csrf"
}
func (h *Handler) setCookies(w http.ResponseWriter, result LoginResult) {
	maxAge := int(time.Until(result.Session.ExpiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{Name: h.sessionCookieName(), Value: result.Token, Path: "/", Secure: h.config.CookieSecure, HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: result.Session.ExpiresAt, MaxAge: maxAge})
	http.SetCookie(w, &http.Cookie{Name: h.csrfCookieName(), Value: result.CSRF, Path: "/", Secure: h.config.CookieSecure, HttpOnly: false, SameSite: http.SameSiteStrictMode, Expires: result.Session.ExpiresAt, MaxAge: maxAge})
}
func (h *Handler) clearCookies(w http.ResponseWriter) {
	for _, cookie := range []*http.Cookie{{Name: h.sessionCookieName(), HttpOnly: true}, {Name: h.csrfCookieName()}} {
		cookie.Value = ""
		cookie.Path = "/"
		cookie.Secure = h.config.CookieSecure
		cookie.SameSite = http.SameSiteStrictMode
		cookie.MaxAge = -1
		cookie.Expires = time.Unix(1, 0)
		http.SetCookie(w, cookie)
	}
}
