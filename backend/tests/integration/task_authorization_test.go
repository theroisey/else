//go:build integration

package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/authorization"
	"github.com/theroisey/else/backend/internal/correlation"
	"github.com/theroisey/else/backend/internal/tasks"
)

func TestTaskExactScopeGranularPermissionsAndLegacyManage(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	a := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
	b := f.create(t, clientBID, tasks.CreateInput{Profile: taskProfile()})
	editor := f.user(t, "task.editor@example.com")
	role, err := f.accounts.CreateRole(ctx, f.actor, "Task Editor", []authorization.Permission{authorization.TasksView, authorization.TasksCreate, authorization.TasksUpdate, authorization.TasksDelete})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(ctx, f.actor, editor.ID, role.ID, authorization.Client, clientAID); err != nil {
		t.Fatal(err)
	}
	login, err := f.service.Login(ctx, "task.editor@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	// Task access does not require unrelated client-profile access.
	assertStatus(t, f.request(t, &login, "GET", taskPath(clientAID)+"/"+a.ID, nil, nil), 200, "")
	for _, client := range []string{clientBID, "99999999-9999-4999-8999-999999999999"} {
		for _, read := range []string{taskPath(client), taskPath(client) + "/" + b.ID, taskPath(client) + "/assignees"} {
			assertStatus(t, f.request(t, &login, "GET", read, nil, nil), 404, "not_found")
		}
		assertStatus(t, f.request(t, &login, "POST", taskPath(client), tasks.CreateInput{Profile: taskProfile()}, nil), 404, "not_found")
		assertStatus(t, f.request(t, &login, "PUT", taskPath(client)+"/"+b.ID, map[string]any{"title": "forged", "expected_revision": 1}, nil), 404, "not_found")
		for _, suffix := range []string{"status", "archive"} {
			body := map[string]any{"expected_revision": 1}
			if suffix == "status" {
				body["status"] = "in_progress"
			} else {
				body["confirm"] = true
			}
			assertStatus(t, f.request(t, &login, "POST", taskPath(client)+"/"+b.ID+"/"+suffix, body, nil), 404, "not_found")
		}
	}
	assertStatus(t, f.request(t, &login, "GET", taskPath(clientAID)+"/"+b.ID, nil, nil), 404, "not_found")
	assertStatus(t, f.request(t, &login, "PUT", taskPath(clientAID)+"/"+b.ID, map[string]any{"title": "forged", "expected_revision": 1}, nil), 404, "not_found")
	taskMutation(t, f.request(t, &login, "POST", taskPath(clientAID), tasks.CreateInput{Profile: taskProfile()}, nil), 201)
	a = taskMutation(t, f.request(t, &login, "PUT", taskPath(clientAID)+"/"+a.ID, map[string]any{"title": "Scoped task", "expected_revision": 1}, nil), 200)
	a = taskMutation(t, f.request(t, &login, "POST", taskPath(clientAID)+"/"+a.ID+"/status", map[string]any{"status": "in_progress", "expected_revision": a.Revision}, nil), 200)
	taskMutation(t, f.request(t, &login, "POST", taskPath(clientAID)+"/"+a.ID+"/archive", map[string]any{"confirm": true, "expected_revision": a.Revision}, nil), 200)
	for _, permission := range []authorization.Permission{authorization.TasksView, authorization.TasksCreate, authorization.TasksUpdate, authorization.TasksDelete, authorization.TasksManage} {
		user := f.user(t, fmt.Sprintf("task.%s@example.com", strings.ReplaceAll(string(permission), ".", "-")))
		r, err := f.accounts.CreateRole(ctx, f.actor, "Only "+string(permission), []authorization.Permission{permission})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.authorizer.AssignRole(ctx, f.actor, user.ID, r.ID, authorization.Client, clientAID); err != nil {
			t.Fatal(err)
		}
		m := f.create(t, clientAID, tasks.CreateInput{Profile: taskProfile()})
		_, createErr := f.tasks.Create(ctx, user.ID, clientAID, tasks.CreateInput{Profile: taskProfile()})
		_, updateErr := f.tasks.Update(ctx, user.ID, clientAID, m.ID, 1, taskProfile())
		rev := int64(1)
		if updateErr == nil {
			rev++
		}
		_, statusErr := f.tasks.Transition(ctx, user.ID, clientAID, m.ID, rev, "in_progress")
		if statusErr == nil {
			rev++
		}
		_, archiveErr := f.tasks.Archive(ctx, user.ID, clientAID, m.ID, rev)
		if (createErr == nil) != (permission == authorization.TasksCreate || permission == authorization.TasksManage) ||
			(updateErr == nil) != (permission == authorization.TasksUpdate || permission == authorization.TasksManage) ||
			(statusErr == nil) != (permission == authorization.TasksUpdate || permission == authorization.TasksManage) ||
			(archiveErr == nil) != (permission == authorization.TasksDelete || permission == authorization.TasksManage) {
			t.Fatal("granular operation boundary failed")
		}
		_, viewErr := f.tasks.Detail(ctx, user.ID, clientAID, m.ID)
		if permission == authorization.TasksView {
			if viewErr != nil {
				t.Fatal("view-only access failed", viewErr)
			}
		} else if !errors.Is(viewErr, tasks.ErrMissing) {
			t.Fatal("write permission implicitly granted view", viewErr)
		}
		if _, err := f.tasks.Assignees(ctx, user.ID, clientAID, "", 25); !errors.Is(err, tasks.ErrMissing) {
			t.Fatal("candidate directory lacked required view", err)
		}
	}
}
func TestTaskAssigneeEligibilityAndHistoricalReferences(t *testing.T) {
	f := newTaskFixture(t)
	ctx := correlation.New(f.base.ctx)
	eligible := f.user(t, "eligible.task@example.com")
	foreign := f.user(t, "foreign.task@example.com")
	disabled := f.user(t, "disabled.task@example.com")
	assignment, err := f.authorizer.AssignRole(ctx, f.actor, eligible.ID, authorization.ViewerRoleID, authorization.Client, clientAID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.authorizer.AssignRole(ctx, f.actor, foreign.ID, authorization.ViewerRoleID, authorization.Client, clientBID); err != nil {
		t.Fatal(err)
	}
	f.assignment(t, disabled.ID, authorization.ViewerRoleID)
	if _, err := f.accounts.DisableUser(ctx, f.actor, disabled.ID, 1); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{foreign.ID, disabled.ID, "99999999-9999-4999-8999-999999999999"} {
		p := taskProfile()
		p.AssigneeID = &id
		assertStatus(t, f.request(t, &f.login, "POST", taskPath(clientAID), tasks.CreateInput{Profile: p}, nil), 400, "invalid_assignee")
	}
	p := taskProfile()
	p.AssigneeID = &eligible.ID
	m := f.create(t, clientAID, tasks.CreateInput{Profile: p})
	for _, id := range []string{foreign.ID, disabled.ID, "99999999-9999-4999-8999-999999999999"} {
		bad := taskProfile()
		bad.AssigneeID = &id
		if _, err := f.tasks.Update(ctx, f.actor, clientAID, m.ID, 1, bad); !errors.Is(err, tasks.ErrAssignee) {
			t.Fatal("invalid replacement assignee accepted", err)
		}
	}
	w := f.request(t, &f.login, "GET", taskPath(clientAID)+"/assignees?limit=1", nil, nil)
	assertStatus(t, w, 200, "")
	var page tasks.Page[tasks.Assignee]
	seen := map[string]bool{}
	for {
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Data) != 1 {
			t.Fatal("bounded candidates failed", err)
		}
		for _, v := range page.Data {
			seen[v.ID] = true
		}
		var raw struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
			t.Fatal(err)
		}
		for _, v := range raw.Data {
			if len(v) != 2 || v["id"] == nil || v["display_name"] == nil {
				t.Fatal("candidate leaked private identity fields")
			}
		}
		if page.Page.NextCursor == nil {
			break
		}
		w = f.request(t, &f.login, "GET", taskPath(clientAID)+"/assignees?limit=1&cursor="+*page.Page.NextCursor, nil, nil)
	}
	if !seen[f.actor] || !seen[eligible.ID] || seen[foreign.ID] || seen[disabled.ID] || len(seen) != 2 {
		t.Fatal("candidate eligibility leaked foreign or disabled users")
	}
	viewerLogin, err := f.service.Login(ctx, "eligible.task@example.com", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, f.request(t, &viewerLogin, "GET", taskPath(clientAID)+"/assignees", nil, nil), 404, "not_found")
	if err := f.authorizer.RevokeRole(ctx, f.actor, assignment); err != nil {
		t.Fatal(err)
	}
	m2, err := f.tasks.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p)
	if err != nil {
		t.Fatal("unchanged revoked assignee lost history", err)
	}
	m = f.status(t, clientAID, m2, "in_progress")
	if _, err := f.tasks.Create(ctx, f.actor, clientAID, tasks.CreateInput{Profile: p}); !errors.Is(err, tasks.ErrAssignee) {
		t.Fatal("revoked user became new assignee", err)
	}
	if _, err := f.accounts.DisableUser(ctx, f.actor, eligible.ID, 1); err != nil {
		t.Fatal(err)
	}
	m2, err = f.tasks.Update(ctx, f.actor, clientAID, m.ID, m.Revision, p)
	if err != nil {
		t.Fatal("unchanged disabled assignee lost history", err)
	}
	p.AssigneeID = nil
	m2, err = f.tasks.Update(ctx, f.actor, clientAID, m2.ID, m2.Revision, p)
	if err != nil {
		t.Fatal("could not clear historical assignee", err)
	}
	detail, err := f.tasks.Detail(ctx, f.actor, clientAID, m2.ID)
	if err != nil || detail.AssigneeID != nil {
		t.Fatal("assignee clear failed", err)
	}
}
