package ga4

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestEveryProviderRequestRequiresFreshCallerFence(t *testing.T) {
	f := newAdapterFixture(t)
	for deniedAt := 1; deniedAt <= 13; deniedAt++ {
		f.calls, f.metadataCalls, f.reportCalls, f.adminCalls = 0, 0, 0, 0
		fences := 0
		result, err := f.adapter.FetchFenced(context.Background(), f.credential, f.request, func(context.Context) error {
			fences++
			if fences == deniedAt {
				return ErrUnavailable
			}
			return nil
		})
		if err != ErrUnavailable || !reflect.DeepEqual(result, Workspace{}) || f.calls != deniedAt-1 || fences != deniedAt {
			t.Fatal("denied lifecycle fence allowed another provider call or partial workspace")
		}
	}
}

func TestStoredWorkspaceCannotCrossClientPeriodSchemaOrPrivacyBoundary(t *testing.T) {
	f := newAdapterFixture(t)
	w, err := f.adapter.Fetch(context.Background(), f.credential, f.request)
	if err != nil || !ValidWorkspace(w, f.request) {
		t.Fatal("collected normalized workspace failed validation")
	}
	raw, _ := json.Marshal(w)
	for _, change := range []func(*Workspace){
		func(w *Workspace) { w.Summary.ClientID = "00000000-0000-4000-8000-000000000099" },
		func(w *Workspace) { w.Daily.Until = "2026-10-02" },
		func(w *Workspace) { w.Definitions[0].Type = "TYPE_FLOAT" },
		func(w *Workspace) { w.Summary.Rows[0].Metrics[0] = "1.5" },
		func(w *Workspace) { w.Landing.Rows[0].Dimensions[0] = "/private?email=synthetic@example.com" },
		func(w *Workspace) { w.Devices.Rows[0].Dimensions = nil },
		func(w *Workspace) { w.Acquisition.Rows = nil },
		func(w *Workspace) { w.Definitions = nil },
		func(w *Workspace) { w.Summary.Rows[0].Metrics[3] = "1.00" },
		func(w *Workspace) { w.Daily.Rows[0].Dimensions[0] = "20260930" },
	} {
		var changed Workspace
		if json.Unmarshal(raw, &changed) != nil {
			t.Fatal("fixture unavailable")
		}
		change(&changed)
		if ValidWorkspace(changed, f.request) {
			t.Fatal("invalid stored workspace passed exact DTO boundary")
		}
	}
}
