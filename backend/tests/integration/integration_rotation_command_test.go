//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/integrations/rotationcommand"
)

type rotationCommandFixture struct {
	*rotationFixture
	environment map[string]string
}

func newRotationCommandFixture(t *testing.T, count int) *rotationCommandFixture {
	t.Helper()
	f := newRotationFixture(t, count)
	file := filepath.Join(t.TempDir(), "synthetic-keys.json")
	writeCommandKeys(t, file, true)
	u, e := url.Parse(f.base.URL)
	if e != nil {
		t.Fatal("synthetic database configuration")
	}
	cfg := f.runtime.Config().ConnConfig
	u.User = url.UserPassword(cfg.User, cfg.Password)
	return &rotationCommandFixture{f, map[string]string{"DATABASE_URL": u.String(), "INTEGRATION_KEYRING_FILE": file}}
}

func writeCommandKeys(t *testing.T, file string, retained bool) {
	t.Helper()
	keys := []map[string]string{{"id": "synthetic-fresh", "key_base64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x73}, 32))}}
	if retained {
		keys = append(keys, map[string]string{"id": "synthetic-primary", "key_base64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x6b}, 32))})
	}
	b, e := json.Marshal(map[string]any{"active_key_id": "synthetic-fresh", "keys": keys})
	if e != nil {
		t.Fatal("synthetic protected source")
	}
	if _, e := os.Stat(file); e == nil && os.Chmod(file, 0600) != nil {
		t.Fatal("synthetic source permissions")
	}
	if os.WriteFile(file, b, 0600) != nil || os.Chmod(file, 0400) != nil {
		t.Fatal("synthetic protected source")
	}
}

func (f *rotationCommandFixture) args(actor, client, after string, limit int) []string {
	args := []string{"--actor", actor, "--client", client, "--limit", strconv.Itoa(limit), "--confirmed"}
	if after != "" {
		args = append(args, "--after", after)
	}
	return args
}

func (f *rotationCommandFixture) run(t *testing.T, actor, client, after string, limit int, output io.Writer) (int, rotationcommand.Report, string) {
	t.Helper()
	var out, diagnostic bytes.Buffer
	if output == nil {
		output = &out
	}
	code := rotationcommand.Run(f.base.ctx, f.args(actor, client, after, limit), func(k string) (string, bool) { v, ok := f.environment[k]; return v, ok }, output, &diagnostic)
	for _, forbidden := range []string{f.environment["DATABASE_URL"], f.environment["INTEGRATION_KEYRING_FILE"], "synthetic-primary", "synthetic-fresh", "synthetic-batch-token", "synthetic-private-commit"} {
		if strings.Contains(out.String()+diagnostic.String(), forbidden) {
			t.Fatal("command exposed private diagnostics")
		}
	}
	var report rotationcommand.Report
	if out.Len() > 0 {
		if out.Len() > 2048 || json.Unmarshal(out.Bytes(), &report) != nil || report.ActorID != actor || report.ClientID != client || report.CorrelationID == "" {
			t.Fatal("unsafe or invalid command report")
		}
	}
	return code, report, diagnostic.String()
}

func TestIntegrationRotationCommandBoundedPagingRestartAndCorrelation(t *testing.T) {
	f := newRotationCommandFixture(t, 3)
	previous := ""
	for _, after := range []string{"", connectionID(1), ""} {
		limit := 1
		if previous != "" && after == "" {
			limit = 100
		}
		code, r, diagnostic := f.run(t, f.actor, clientAID, after, limit, nil)
		if code != 0 || diagnostic != "" || r.Status != "page_complete" || r.ErrorCode != "" || !r.PageComplete || r.Rewrapped != 1 || r.Pending != "" || r.CorrelationID == previous || r.More != (limit == 1) {
			t.Fatal("one-page command progress incorrect")
		}
		previous = r.CorrelationID
		var count int
		if e := f.admin.QueryRow(f.base.ctx, `SELECT count(*) FROM app.audit_events WHERE request_id=$1`, r.CorrelationID).Scan(&count); e != nil || count != 3 {
			t.Fatal("page audit correlation missing", e)
		}
	}
	for n := 1; n <= 3; n++ {
		f.assertRow(t, n, true, 3, 2, 2)
	}
	if n, events := f.accounting(t); n != 6 || events != 6 {
		t.Fatal("command repeated completed work")
	}
}

func TestIntegrationRotationCommandFreshGrantsEvenOnEmptyForeignClient(t *testing.T) {
	f := newRotationCommandFixture(t, 1)
	actor, assignment := f.grant(t, []authorization.Permission{authorization.ClientsView, authorization.IntegrationsManage}, clientAID)
	code, r, d := f.run(t, actor, clientBID, "", 1, nil)
	if code != 1 || d != "" || r.ErrorCode != "integration_rotation_missing" || r.PageComplete || r.Rewrapped != 0 {
		t.Fatal("empty foreign client scan permitted")
	}
	if e := f.authorizer.RevokeRole(correlation.New(f.base.ctx), f.actor, assignment); e != nil {
		t.Fatal(e)
	}
	code, r, d = f.run(t, actor, clientAID, "", 1, nil)
	if code != 1 || d != "" || r.ErrorCode != "integration_rotation_missing" || r.Rewrapped != 0 {
		t.Fatal("revoked management accepted")
	}
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("denied command consumed capacity")
	}
}

func TestIntegrationRotationCommandDeclaredRestoreRequiresExplicitModeTransition(t *testing.T) {
	f := newRotationCommandFixture(t, 2)
	f.environment["INTEGRATION_KEYRING_MODE"] = "restored"
	code, r, d := f.run(t, f.actor, clientAID, "", 1, nil)
	if code != 0 || d != "" || r.Rewrapped != 1 || !r.More {
		t.Fatal("fresh restored command failed")
	}
	code, r, d = f.run(t, f.actor, clientAID, connectionID(1), 1, nil)
	if code != 1 || r.CorrelationID != "" || !strings.Contains(d, "integration_rotation_key_preflight_failed") {
		t.Fatal("restored command silently reused registered key")
	}
	f.assertRow(t, 2, false, 2, 1, 2)
	f.environment["INTEGRATION_KEYRING_MODE"] = "normal"
	code, r, d = f.run(t, f.actor, clientAID, connectionID(1), 1, nil)
	if code != 0 || d != "" || r.Rewrapped != 1 || r.More || !r.PageComplete {
		t.Fatal("explicit restored-to-normal transition failed")
	}
}

func TestIntegrationRotationCommandRejectedSourceAndStartupDoNotMutate(t *testing.T) {
	f := newRotationCommandFixture(t, 1)
	file := f.environment["INTEGRATION_KEYRING_FILE"]
	for _, mode := range []os.FileMode{0444, 0400} {
		if os.Chmod(file, mode) != nil {
			t.Fatal("synthetic source permissions")
		}
		if mode == 0400 {
			writeCommandKeys(t, file, false)
		}
		code, r, d := f.run(t, f.actor, clientAID, "", 1, nil)
		want := "integration_rotation_key_source_failed"
		if mode == 0400 {
			want = "integration_rotation_key_preflight_failed"
		}
		if code != 1 || r.CorrelationID != "" || !strings.Contains(d, want) {
			t.Fatal("insecure/missing-retained source accepted")
		}
	}
	if os.Chmod(file, 0600) != nil {
		t.Fatal("synthetic source permissions")
	}
	writeCommandKeys(t, file, true)
	f.environment["DATABASE_URL"] = "postgres://synthetic-private-database"
	code, r, d := f.run(t, f.actor, clientAID, "", 1, nil)
	if code != 1 || r.CorrelationID != "" || !strings.Contains(d, "database_configuration_failed") {
		t.Fatal("invalid database configuration accepted")
	}
	if n, events := f.accounting(t); n != 1 || events != 1 {
		t.Fatal("startup failure consumed capacity")
	}
	f.assertRow(t, 1, false, 2, 1, 2)
}

func TestIntegrationRotationCommandPartialFailureReportsOnlyKnownCommits(t *testing.T) {
	f := newRotationCommandFixture(t, 3)
	if _, e := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.synthetic_command_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic-private-commit'; END $$;
 CREATE CONSTRAINT TRIGGER synthetic_command_commit_failure AFTER UPDATE ON app.integration_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.connection_id='e3000000-0000-4000-8000-000000000002'::uuid) EXECUTE FUNCTION app.synthetic_command_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	code, r, d := f.run(t, f.actor, clientAID, "", 3, nil)
	if code != 1 || d != "" || r.Status != "attention_required" || r.ErrorCode != "integration_rotation_unavailable" || r.Rewrapped != 1 || r.ResumeAfter != connectionID(1) || r.Pending != connectionID(2) || r.PageComplete {
		t.Fatal("partial failure advanced unconfirmed progress")
	}
	f.assertRow(t, 1, true, 3, 2, 2)
	f.assertRow(t, 2, false, 2, 1, 2)
	f.assertRow(t, 3, false, 2, 1, 2)
	if n, events := f.accounting(t); n != 5 || events != 5 {
		t.Fatal("partial failure retried/refunded reservation")
	}
	if _, e := f.admin.Exec(f.base.ctx, `DROP TRIGGER synthetic_command_commit_failure ON app.integration_credentials`); e != nil {
		t.Fatal(e)
	}
	code, r, d = f.run(t, f.actor, clientAID, connectionID(1), 3, nil)
	if code != 0 || d != "" || r.Rewrapped != 2 || !r.PageComplete {
		t.Fatal("reconciled explicit resume failed")
	}
}

func TestIntegrationRotationCommandFailedFirstRestoredWriteStillRegistersMaterial(t *testing.T) {
	f := newRotationCommandFixture(t, 1)
	f.environment["INTEGRATION_KEYRING_MODE"] = "restored"
	if _, e := f.admin.Exec(f.base.ctx, `CREATE FUNCTION app.synthetic_first_restore_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic-private-commit'; END $$;
 CREATE CONSTRAINT TRIGGER synthetic_first_restore_failure AFTER UPDATE ON app.integration_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.synthetic_first_restore_failure()`); e != nil {
		t.Fatal(e)
	}
	code, r, d := f.run(t, f.actor, clientAID, "", 1, nil)
	if code != 1 || d != "" || r.Rewrapped != 0 || r.Pending != connectionID(1) || r.PageComplete {
		t.Fatal("failed first restored row misreported")
	}
	f.assertRow(t, 1, false, 2, 1, 2)
	if n, events := f.accounting(t); n != 2 || events != 2 {
		t.Fatal("failed first write lost audited reservation")
	}
	code, r, d = f.run(t, f.actor, clientAID, "", 1, nil)
	if code != 1 || r.CorrelationID != "" || !strings.Contains(d, "integration_rotation_key_preflight_failed") {
		t.Fatal("failed first write silently changed restore mode")
	}
	if _, e := f.admin.Exec(f.base.ctx, `DROP TRIGGER synthetic_first_restore_failure ON app.integration_credentials`); e != nil {
		t.Fatal(e)
	}
	f.environment["INTEGRATION_KEYRING_MODE"] = "normal"
	code, r, d = f.run(t, f.actor, clientAID, "", 1, nil)
	if code != 0 || d != "" || r.Rewrapped != 1 || !r.PageComplete {
		t.Fatal("reconciled failed-first-write transition failed")
	}
	if n, events := f.accounting(t); n != 3 || events != 3 {
		t.Fatal("reconciliation refunded reservation")
	}
}

type lostCommandOutput struct{}

func (lostCommandOutput) Write([]byte) (int, error) { return 0, errors.New("synthetic-private-output") }

func TestIntegrationRotationCommandOutputLossDoesNotRetryCommittedPage(t *testing.T) {
	f := newRotationCommandFixture(t, 2)
	code, r, d := f.run(t, f.actor, clientAID, "", 1, lostCommandOutput{})
	if code != 1 || r.CorrelationID != "" || !strings.Contains(d, "integration_rotation_output_failed") || strings.Contains(d, "synthetic-private-output") {
		t.Fatal("output loss reported success/private error")
	}
	f.assertRow(t, 1, true, 3, 2, 2)
	f.assertRow(t, 2, false, 2, 1, 2)
	if n, events := f.accounting(t); n != 3 || events != 3 {
		t.Fatal("output loss retried committed page")
	}
	code, r, d = f.run(t, f.actor, clientAID, "", 100, nil)
	if code != 0 || d != "" || r.Rewrapped != 1 || !r.PageComplete {
		t.Fatal("explicit reconciled restart repeated committed work")
	}
	ctx, cancel := context.WithCancel(f.base.ctx)
	cancel()
	var out, diagnostic bytes.Buffer
	if rotationcommand.Run(ctx, f.args(f.actor, clientAID, "", 1), func(string) (string, bool) { t.Fatal("canceled command read configuration"); return "", false }, &out, &diagnostic) != 1 {
		t.Fatal("canceled command succeeded")
	}
}
