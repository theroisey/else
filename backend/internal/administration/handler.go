package administration

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/theroisey/else/backend/internal/authorization"
	httpapi "github.com/theroisey/else/backend/internal/http"
	"github.com/theroisey/else/backend/internal/identity"
)

type Handler struct {
	service     *Service
	auth        *identity.Handler
	permissions *authorization.Service
	logger      *slog.Logger
}

func NewHandler(service *Service, auth *identity.Handler, permissions *authorization.Service, logger *slog.Logger) (*Handler, error) {
	if service == nil || auth == nil || permissions == nil || logger == nil {
		return nil, ErrInvalid
	}
	return &Handler{service: service, auth: auth, permissions: permissions, logger: logger}, nil
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	session, ok := h.auth.AuthenticateRequest(w, r)
	if !ok {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/"), "/")
	isUser := parts[0] == "users"
	isRoles := parts[0] == "roles" || parts[0] == "permissions" || (isUser && len(parts) >= 3 && parts[2] == "roles")
	if !isUser && !isRoles {
		h.fail(w, r, ErrMissing)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodPatch && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, PATCH, PUT, DELETE")
		httpapi.WriteError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
		return
	}
	required := authorization.UsersView
	if isRoles {
		required = authorization.RolesView
	}
	if r.Method != http.MethodGet {
		required = authorization.UsersManage
		if isRoles {
			required = authorization.RolesManage
		}
		if !h.auth.VerifyMutation(w, r, session) {
			return
		}
	}
	allowed, err := h.permissions.Allowed(r.Context(), session.User.ID, required, "")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if !allowed {
		h.fail(w, r, ErrDenied)
		return
	}
	if len(parts) > 1 && !validID(parts[1]) {
		h.fail(w, r, ErrInvalid)
		return
	}
	actor := session.User.ID
	if r.Method == http.MethodGet {
		h.read(w, r, parts, actor)
		return
	}
	h.write(w, r, parts, actor)
}
func (h *Handler) read(w http.ResponseWriter, r *http.Request, parts []string, actor string) {
	if len(parts) == 1 && parts[0] == "permissions" {
		catalog, err := h.service.Catalog(r.Context(), actor)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		h.data(w, r, http.StatusOK, catalog)
		return
	}
	if len(parts) == 2 {
		switch parts[0] {
		case "users":
			item, err := h.service.User(r.Context(), actor, parts[1])
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, http.StatusOK, item)
		case "roles":
			item, err := h.service.Role(r.Context(), actor, parts[1])
			if err != nil {
				h.fail(w, r, err)
				return
			}
			h.data(w, r, http.StatusOK, item)
		default:
			h.fail(w, r, ErrMissing)
		}
		return
	}
	cursor, limit, err := pagination(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if len(parts) == 1 {
		if parts[0] == "users" {
			page, err := h.service.Users(r.Context(), actor, cursor, limit)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			httpapi.WriteJSON(w, r, http.StatusOK, page)
			return
		}
		if parts[0] == "roles" {
			page, err := h.service.Roles(r.Context(), actor, cursor, limit)
			if err != nil {
				h.fail(w, r, err)
				return
			}
			httpapi.WriteJSON(w, r, http.StatusOK, page)
			return
		}
	}
	if len(parts) == 3 && parts[0] == "users" && parts[2] == "roles" {
		page, err := h.service.Assignments(r.Context(), actor, parts[1], cursor, limit)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		httpapi.WriteJSON(w, r, http.StatusOK, page)
		return
	}
	h.fail(w, r, ErrMissing)
}
func (h *Handler) write(w http.ResponseWriter, r *http.Request, parts []string, actor string) {
	var result Mutation
	var err error
	status := http.StatusOK
	switch {
	case len(parts) == 1 && parts[0] == "users" && r.Method == http.MethodPost:
		var input struct {
			Email       string `json:"email"`
			DisplayName string `json:"display_name"`
			Password    string `json:"password"`
		}
		if !decode(w, r, &input) {
			return
		}
		result, err = h.service.CreateUser(r.Context(), actor, input.Email, input.DisplayName, input.Password)
		status = http.StatusCreated
	case len(parts) == 2 && parts[0] == "users" && r.Method == http.MethodPatch:
		var input struct {
			Email       string `json:"email"`
			DisplayName string `json:"display_name"`
			Revision    int64  `json:"expected_revision"`
		}
		if !decode(w, r, &input) {
			return
		}
		result, err = h.service.UpdateUser(r.Context(), actor, parts[1], input.Revision, input.Email, input.DisplayName)
	case len(parts) == 3 && parts[0] == "users" && parts[2] == "disable" && r.Method == http.MethodPost:
		var input struct {
			Revision int64 `json:"expected_revision"`
			Confirm  bool  `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		result, err = h.service.DisableUser(r.Context(), actor, parts[1], input.Revision)
	case len(parts) == 1 && parts[0] == "roles" && r.Method == http.MethodPost:
		var input struct {
			DisplayName string                     `json:"display_name"`
			Permissions []authorization.Permission `json:"permissions"`
		}
		if !decode(w, r, &input) {
			return
		}
		result, err = h.service.CreateRole(r.Context(), actor, input.DisplayName, input.Permissions)
		status = http.StatusCreated
	case len(parts) == 3 && parts[0] == "roles" && parts[2] == "permissions" && r.Method == http.MethodPut:
		var input struct {
			Revision    int64                      `json:"expected_revision"`
			Permissions []authorization.Permission `json:"permissions"`
			Confirm     bool                       `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		result, err = h.service.ReplacePermissions(r.Context(), actor, parts[1], input.Revision, input.Permissions)
	case len(parts) == 3 && parts[0] == "users" && parts[2] == "roles" && r.Method == http.MethodPost:
		var input struct {
			RoleID   string              `json:"role_id"`
			Scope    authorization.Scope `json:"scope"`
			ClientID string              `json:"client_id"`
			Confirm  bool                `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		result.ID, err = h.permissions.AssignRole(r.Context(), actor, parts[1], input.RoleID, input.Scope, input.ClientID)
		status = http.StatusCreated
	case len(parts) == 4 && parts[0] == "users" && parts[2] == "roles" && r.Method == http.MethodDelete:
		var input struct {
			Confirm bool `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !input.Confirm {
			h.fail(w, r, ErrInvalid)
			return
		}
		err = h.service.RevokeAssignment(r.Context(), actor, parts[1], parts[3])
		if err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	default:
		h.fail(w, r, ErrMissing)
		return
	}
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.data(w, r, status, result)
}
func (h *Handler) data(w http.ResponseWriter, r *http.Request, status int, value any) {
	httpapi.WriteJSON(w, r, status, struct {
		Data any `json:"data"`
	}{Data: value})
}
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "An internal error occurred."
	switch {
	case errors.Is(err, ErrInvalid), errors.Is(err, authorization.ErrInvalidInput):
		status, code, message = http.StatusBadRequest, "invalid_request", "Request body or pagination is invalid."
	case errors.Is(err, ErrDenied), errors.Is(err, authorization.ErrDenied):
		status, code, message = http.StatusForbidden, "permission_denied", "Your permissions do not allow this operation."
	case errors.Is(err, ErrMissing):
		status, code, message = http.StatusNotFound, "not_found", "Resource not found."
	case errors.Is(err, ErrLastAdministrator):
		status, code, message = http.StatusConflict, "last_administrator", "At least one active administrator must remain."
	case errors.Is(err, ErrSelfDisable):
		status, code, message = http.StatusConflict, "self_disable", "You cannot disable your own account."
	case errors.Is(err, ErrSystemRole):
		status, code, message = http.StatusConflict, "system_role", "Built-in roles are read only."
	case errors.Is(err, ErrConflict):
		status, code, message = http.StatusConflict, "conflict", "The record changed or conflicts with an existing record. Refresh before trying again."
	}
	if status == http.StatusInternalServerError {
		h.logger.ErrorContext(r.Context(), "administration_error", "request_id", httpapi.RequestID(r.Context()), "error_code", code)
	}
	httpapi.WriteError(w, r, status, code, message)
}
func decode(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
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
func pagination(r *http.Request) (string, int, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "", 0, ErrInvalid
	}
	cursor, limit := query.Get("cursor"), 25
	for key, values := range query {
		if (key != "cursor" && key != "limit") || len(values) != 1 || values[0] == "" {
			return "", 0, ErrInvalid
		}
	}
	if value := query.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil {
			return "", 0, ErrInvalid
		}
	}
	if !validPage(cursor, limit) {
		return "", 0, ErrInvalid
	}
	return cursor, limit, nil
}
