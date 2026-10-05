//go:build integration

package integration

import (
	"errors"
	"reflect"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/clients"
	"github.com/theroisey/else/backend/internal/correlation"
)

func TestClientDirectoryGrantMigrationPreservesVisibilityPaginationAndACL(t *testing.T) {
	f := newClientFixture(t)
	ctx := correlation.New(f.base.ctx)
	scoped := f.user(t, "directory.scoped@example.com")
	denied := f.user(t, "directory.denied@example.com")
	assign := func(clientID string) string {
		t.Helper()
		id, err := f.authorizer.AssignRole(ctx, f.actor, scoped.ID, authorization.ViewerRoleID, authorization.Client, clientID)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	assignmentA, assignmentB := assign(clientAID), assign(clientBID)
	for _, name := range []string{"Synthetic % literal", "Synthetic archived", "Synthetic other"} {
		profile := profileFixture()
		profile.Name = name
		created, err := f.records.Create(ctx, f.actor, profile)
		if err != nil {
			t.Fatal(err)
		}
		if name == "Synthetic archived" {
			if _, err := f.records.Archive(ctx, f.actor, created.ID, created.Revision); err != nil {
				t.Fatal(err)
			}
		}
	}
	filters := []clients.Filter{
		{Limit: 1, Status: "all", Sort: "id"},
		{Limit: 1, Status: "all", Sort: "-id"},
		{Limit: 100, Status: "active", Sort: "id"},
		{Limit: 100, Status: "archived", Sort: "-id"},
		{Limit: 100, Status: "all", Sort: "id", Search: "%"},
		{Limit: 100, Status: "all", Sort: "id", Search: "SYNTHETIC", Tag: "priority"},
		{Limit: 100, Status: "all", Sort: "id", Tag: "absent"},
	}
	type result struct {
		Pages  []clients.Page
		Denied bool
	}
	read := func() []result {
		t.Helper()
		var results []result
		for _, actor := range []string{f.actor, scoped.ID, denied.ID} {
			for _, filter := range filters {
				var observation result
				for count := 0; ; count++ {
					if count >= 10 {
						t.Fatal("client pagination did not terminate")
					}
					page, err := f.records.List(ctx, actor, filter)
					if errors.Is(err, clients.ErrDenied) {
						observation.Denied = true
						break
					}
					if err != nil {
						t.Fatal(err)
					}
					observation.Pages = append(observation.Pages, page)
					if page.Page.NextCursor == nil {
						break
					}
					filter.Cursor = *page.Page.NextCursor
				}
				results = append(results, observation)
			}
		}
		return results
	}
	acl := func() string {
		t.Helper()
		var value string
		if err := f.admin.QueryRow(ctx, `SELECT pg_get_userbyid(proowner)||':'||coalesce(proacl::text,'') FROM pg_proc WHERE oid='app.client_list(uuid,uuid,integer,text,text,text,boolean)'::regprocedure`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	optimized, privileges := read(), acl()
	p := provider(t, f.base)
	if _, err := p.Down(f.base.ctx); err != nil {
		t.Fatal("client directory rollback failed", err)
	}
	if legacy := read(); !reflect.DeepEqual(optimized, legacy) || acl() != privileges {
		t.Fatal("directory optimization changed legacy visibility, filters, pagination, documents or privileges")
	}
	if _, err := p.Up(f.base.ctx); err != nil {
		t.Fatal("client directory reapply failed", err)
	}
	if reapplied := read(); !reflect.DeepEqual(optimized, reapplied) || acl() != privileges {
		t.Fatal("directory migration round trip changed results or privileges")
	}
	filter := clients.Filter{Limit: 100, Status: "all", Sort: "id"}
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignmentA); err != nil {
		t.Fatal(err)
	}
	page, err := f.records.List(ctx, scoped.ID, filter)
	if err != nil || len(page.Data) != 1 || page.Data[0].ID != clientBID {
		t.Fatal("directory reused revoked client grants", err)
	}
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignmentB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.records.List(ctx, scoped.ID, filter); !errors.Is(err, clients.ErrDenied) {
		t.Fatal("directory reused revoked final grant", err)
	}
}
