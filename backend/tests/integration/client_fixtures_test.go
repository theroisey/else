//go:build integration

package integration

import "testing"

// Existing authorization/admin tests use real, explicitly synthetic scope rows.
func seedClientScopes(t *testing.T, f *identityFixture) {
	t.Helper()
	for _, sql := range []string{`INSERT INTO app.client_scopes(id) VALUES($1::uuid),($2::uuid)`,
		`INSERT INTO app.clients(id,name) VALUES($1::uuid,'Synthetic Scope A'),($2::uuid,'Synthetic Scope B')`} {
		if _, err := f.admin.Exec(f.base.ctx, sql, clientAID, clientBID); err != nil {
			t.Fatal(err)
		}
	}
}
