// Package rotationcommand is a trusted operator transport for one rotation page
// or one read-only live inventory observation.
// Runtime database/key access is privileged writer authority. Actor arguments
// are checked audit attribution, not end-user authentication. Never expose this
// entrypoint to untrusted actors or public requests.
package rotationcommand

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"time"

	"github.com/theroisey/else/backend/internal/config"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/database"
	"github.com/theroisey/else/backend/internal/integrations/inventory"
	"github.com/theroisey/else/backend/internal/integrations/keysource"
	"github.com/theroisey/else/backend/internal/integrations/rotation"
)

const usage = "Usage: rotate-integration-credentials --actor UUID --client UUID --limit 1..100 [--after UUID] --confirmed\nInventory: rotate-integration-credentials --inventory --actor UUID\nTrusted operators only; actor is audit attribution. One page; reconcile failures before resuming. Inventory requires global view/manage grants and cannot approve key retirement.\nRequires protected INTEGRATION_KEYRING_FILE and runtime DATABASE_URL; optional INTEGRATION_KEYRING_MODE=normal|restored.\n"

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type request struct {
	actor, client, after string
	limit                int
	inventory            bool
}

func validID(id string) bool {
	return uuid.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}

func parse(args []string) (request, bool) {
	var r request
	if len(args) == 3 {
		if args[0] == "--inventory" && args[1] == "--actor" && validID(args[2]) {
			return request{actor: args[2], inventory: true}, true
		}
		if args[0] == "--actor" && args[2] == "--inventory" && validID(args[1]) {
			return request{actor: args[1], inventory: true}, true
		}
		return r, false
	}
	if len(args) < 7 || len(args) > 9 {
		return r, false
	}
	seen := make(map[string]bool, 5)
	for i := 0; i < len(args); i++ {
		flag := args[i]
		if seen[flag] {
			return request{}, false
		}
		seen[flag] = true
		if flag == "--confirmed" {
			continue
		}
		if i+1 >= len(args) {
			return request{}, false
		}
		i++
		value := args[i]
		switch flag {
		case "--actor":
			r.actor = value
		case "--client":
			r.client = value
		case "--after":
			r.after = value
		case "--limit":
			var err error
			r.limit, err = strconv.Atoi(value)
			if err != nil || strconv.Itoa(r.limit) != value {
				return request{}, false
			}
		default:
			return request{}, false
		}
	}
	return r, seen["--confirmed"] && validID(r.actor) && validID(r.client) &&
		(!seen["--after"] || validID(r.after)) && r.limit >= 1 && r.limit <= rotation.MaxPageSize
}

// Report exposes only safe page progress, never a retirement or provider claim.
// A failed/lost report cannot establish that no mutation committed.
type Report struct {
	Status        string `json:"status"`
	ErrorCode     string `json:"error_code,omitempty"`
	ActorID       string `json:"actor_id"`
	ClientID      string `json:"client_id"`
	CorrelationID string `json:"correlation_id"`
	Rewrapped     int    `json:"rewrapped"`
	ResumeAfter   string `json:"resume_after"`
	Pending       string `json:"pending"`
	PageComplete  bool   `json:"page_complete"`
	More          bool   `json:"more"`
}

func writeJSON(w io.Writer, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		return io.ErrShortWrite
	}
	return err
}

func diagnostic(w io.Writer, code string) {
	// Even a failed diagnostic sink must not escape as a raw panic/stack trace.
	defer func() { _ = recover() }()
	if w != nil {
		_ = writeJSON(w, struct {
			Status string `json:"status"`
			Code   string `json:"error_code"`
		}{"attention_required", code})
	}
}

func errorCode(err error) string {
	switch {
	case errors.Is(err, rotation.ErrInvalid):
		return "integration_rotation_invalid"
	case errors.Is(err, rotation.ErrMissing):
		return "integration_rotation_missing"
	case errors.Is(err, rotation.ErrConflict):
		return "integration_rotation_conflict"
	case errors.Is(err, rotation.ErrExhausted):
		return "integration_rotation_exhausted"
	default:
		return "integration_rotation_unavailable"
	}
}

// Run validates mutating confirmation or explicit read-only inventory grammar
// before configuration. It performs one page or observation, with no retries,
// persisted cursor or automatic mode changes.
// Exit 1, partial output, or output loss requires explicit reconciliation.
func Run(ctx context.Context, args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) (code int) {
	defer func() {
		if recover() != nil {
			code = 1
			diagnostic(stderr, "integration_rotation_internal_error")
		}
	}()
	if len(args) == 1 && args[0] == "--help" {
		if stdout == nil {
			diagnostic(stderr, "integration_rotation_output_failed")
			return 1
		}
		n, err := io.WriteString(stdout, usage)
		if err != nil || n != len(usage) {
			diagnostic(stderr, "integration_rotation_output_failed")
			return 1
		}
		return 0
	}
	r, valid := parse(args)
	if !valid {
		diagnostic(stderr, "integration_rotation_invalid")
		return 2
	}
	if ctx == nil || ctx.Err() != nil || lookup == nil || stdout == nil || stderr == nil {
		diagnostic(stderr, "integration_rotation_unavailable")
		return 1
	}
	bounded, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	settings, err := keysource.LoadSettings(lookup)
	if err != nil || !settings.Enabled() {
		diagnostic(stderr, "integration_rotation_key_configuration_failed")
		return 1
	}
	ring, err := keysource.Read(bounded, settings)
	if err != nil {
		diagnostic(stderr, "integration_rotation_key_source_failed")
		return 1
	}
	cfg, err := config.LoadDatabase(lookup, "DATABASE_URL")
	if err != nil {
		diagnostic(stderr, "integration_rotation_database_configuration_failed")
		return 1
	}
	pool, err := database.Open(bounded, cfg)
	if err != nil {
		diagnostic(stderr, "integration_rotation_database_unavailable")
		return 1
	}
	defer pool.Close()
	if r.inventory {
		service, e := inventory.NewService(pool, ring)
		if e != nil {
			diagnostic(stderr, "integration_inventory_unavailable")
			return 1
		}
		operation := correlation.New(bounded)
		counts, e := service.Observe(operation, r.actor, settings.Restored())
		if e != nil {
			code := "integration_inventory_unavailable"
			if errors.Is(e, inventory.ErrMissing) {
				code = "integration_inventory_missing"
			}
			if errors.Is(e, inventory.ErrInvalid) {
				code = "integration_inventory_invalid"
			}
			diagnostic(stderr, code)
			return 1
		}
		report := struct {
			Status        string            `json:"status"`
			ActorID       string            `json:"actor_id"`
			CorrelationID string            `json:"correlation_id"`
			Keys          []inventory.Count `json:"keys"`
		}{"inventory_observed", r.actor, correlation.ID(operation), counts}
		if writeJSON(stdout, report) != nil {
			diagnostic(stderr, "integration_rotation_output_failed")
			return 1
		}
		return 0
	}
	if keysource.Preflight(bounded, pool, ring, settings.Restored()) != nil {
		diagnostic(stderr, "integration_rotation_key_preflight_failed")
		return 1
	}
	service, err := rotation.NewService(pool, ring)
	if err != nil {
		diagnostic(stderr, "integration_rotation_unavailable")
		return 1
	}
	operation := correlation.New(bounded)
	result, err := service.Run(operation, r.actor, r.client, r.after, r.limit)
	report := Report{
		Status: "page_complete", ActorID: r.actor, ClientID: r.client, CorrelationID: correlation.ID(operation),
		Rewrapped: result.Rewrapped, ResumeAfter: result.ResumeAfter, Pending: result.Pending,
		PageComplete: result.PageComplete, More: result.More,
	}
	if err != nil {
		report.Status, report.ErrorCode = "attention_required", errorCode(err)
		code = 1
	}
	if writeJSON(stdout, report) != nil {
		diagnostic(stderr, "integration_rotation_output_failed")
		return 1
	}
	return code
}
