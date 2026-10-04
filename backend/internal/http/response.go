package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/theroisey/else/backend/internal/correlation"
)

func RequestID(ctx context.Context) string {
	return correlation.ID(ctx)
}

type errorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	WriteError(w, r, status, code, message)
}

func WriteError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	if r.Context().Err() == context.DeadlineExceeded {
		status, code, message = http.StatusServiceUnavailable, "request_timeout", "The request timed out. Refresh before retrying."
	}
	var response errorResponse
	response.Error.Code = code
	response.Error.Message = message
	response.Error.RequestID = RequestID(r.Context())
	writeJSON(w, r, status, response)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	WriteJSON(w, r, status, value)
}

func WriteJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	// Encode before committing headers so encoding failures cannot yield partial JSON.
	payload, err := json.Marshal(value)
	if err != nil {
		panic("response encoding failed")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		if _, err := w.Write(append(payload, '\n')); err != nil {
			// The response is already committed. Abort the connection rather than
			// silently reporting successful delivery or exposing transport errors.
			panic(http.ErrAbortHandler)
		}
	}
}
