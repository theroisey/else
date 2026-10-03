package rotationcommand

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/theroisey/else/backend/internal/integrations/rotation"
)

const actor = "11111111-1111-4111-8111-111111111111"
const client = "22222222-2222-4222-8222-222222222222"

func arguments() []string {
	return []string{"--actor", actor, "--client", client, "--limit", "2", "--confirmed"}
}

func TestRejectedArgumentsNeverReadConfiguration(t *testing.T) {
	cases := [][]string{nil, {"private-value"}, {"--help", "private-value"},
		{"--actor", actor, "--client", client, "--limit", "1"},
		{"--actor=" + actor, "--client", client, "--limit", "1", "--confirmed"},
	}
	for _, flag := range []string{"--actor", "--client", "--limit", "--confirmed", "--private-value"} {
		cases = append(cases, append(arguments(), flag, "private-value"))
	}
	for _, id := range []string{"", "private-value", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "00000000-0000-0000-0000-000000000000"} {
		for _, flag := range []string{"--actor", "--client", "--after"} {
			args := arguments()
			if flag == "--after" {
				args = append(args, flag, id)
			} else if flag == "--actor" {
				args[1] = id
			} else {
				args[3] = id
			}
			cases = append(cases, args)
		}
	}
	for _, limit := range []string{"0", "101", "01", "+1", "-1", "1.0", " 1", "private-value"} {
		args := arguments()
		args[5] = limit
		cases = append(cases, args)
	}
	for _, args := range cases {
		var out, errOut bytes.Buffer
		code := Run(context.Background(), args, func(string) (string, bool) {
			t.Fatal("rejected invocation read configuration")
			return "", false
		}, &out, &errOut)
		if code != 2 || out.Len() != 0 || errOut.String() != "{\"status\":\"attention_required\",\"error_code\":\"integration_rotation_invalid\"}\n" {
			t.Fatal("invalid invocation did not fail safely")
		}
	}
}

func TestConfirmationOrderAndOptionalCursor(t *testing.T) {
	for _, args := range [][]string{arguments(), {"--confirmed", "--after", actor, "--limit", "100", "--client", client, "--actor", actor}} {
		var out, errOut bytes.Buffer
		called := false
		code := Run(context.Background(), args, func(string) (string, bool) { called = true; return "", false }, &out, &errOut)
		if code != 1 || !called || out.Len() != 0 || !strings.Contains(errOut.String(), "integration_rotation_key_configuration_failed") {
			t.Fatal("valid invocation failed argument boundary")
		}
	}
}

func TestInventoryGrammarIsExplicitAndCannotMixMutationFlags(t *testing.T) {
	for _, args := range [][]string{{"--inventory", "--actor", actor}, {"--actor", actor, "--inventory"}} {
		var out, errOut bytes.Buffer
		called := false
		if Run(context.Background(), args, func(string) (string, bool) { called = true; return "", false }, &out, &errOut) != 1 || !called || out.Len() != 0 || !strings.Contains(errOut.String(), "key_configuration_failed") {
			t.Fatal("valid inventory did not reach configuration")
		}
	}
	cases := [][]string{{"--inventory"}, {"--inventory", "--actor", "00000000-0000-0000-0000-000000000000"}, {"--inventory", "--actor", actor, "--inventory"}, {"--inventory", "--actor", actor, "--confirmed"}, append(arguments(), "--inventory")}
	for _, flag := range []string{"--client", "--after", "--limit", "--private"} {
		cases = append(cases, []string{"--inventory", "--actor", actor, flag, client})
	}
	for _, args := range cases {
		var out, errOut bytes.Buffer
		if Run(context.Background(), args, func(string) (string, bool) { t.Fatal("mixed/invalid inventory read configuration"); return "", false }, &out, &errOut) != 2 || out.Len() != 0 || !strings.Contains(errOut.String(), "integration_rotation_invalid") {
			t.Fatal("mixed/invalid inventory accepted")
		}
	}
}

func TestHelpAndCancellationNeverReadConfiguration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		args []string
		code int
	}{{[]string{"--help"}, 0}, {arguments(), 1}} {
		var out, errOut bytes.Buffer
		code := Run(ctx, tc.args, func(string) (string, bool) { t.Fatal("help/canceled command read configuration"); return "", false }, &out, &errOut)
		if code != tc.code {
			t.Fatal("help/cancellation exit status")
		}
		if code == 0 && (out.String() != usage || errOut.Len() != 0) {
			t.Fatal("help leaked configuration")
		}
	}
}

func TestUnexpectedFailuresAndTypedErrorsNeverExposeDiagnostics(t *testing.T) {
	var out, errOut bytes.Buffer
	if Run(context.Background(), arguments(), func(string) (string, bool) { panic("private-value") }, &out, &errOut) != 1 || out.Len() != 0 || strings.Contains(errOut.String(), "private-value") || !strings.Contains(errOut.String(), "internal_error") {
		t.Fatal("unexpected failure exposed raw diagnostics")
	}
	for err, want := range map[error]string{
		rotation.ErrInvalid: "integration_rotation_invalid", rotation.ErrMissing: "integration_rotation_missing",
		rotation.ErrConflict: "integration_rotation_conflict", rotation.ErrExhausted: "integration_rotation_exhausted",
		rotation.ErrUnavailable: "integration_rotation_unavailable", errors.New("private-value"): "integration_rotation_unavailable",
	} {
		if errorCode(err) != want {
			t.Fatal("unsafe operational error classification")
		}
	}
}

type failedOutput struct{ short bool }

func (w failedOutput) Write(b []byte) (int, error) {
	if w.short {
		return len(b) - 1, nil
	}
	return 0, errors.New("private-output-value")
}

func TestOutputFailureAndShortWritesAreNotSuccess(t *testing.T) {
	for _, writer := range []io.Writer{failedOutput{}, failedOutput{short: true}} {
		var errOut bytes.Buffer
		if Run(context.Background(), []string{"--help"}, nil, writer, &errOut) != 1 || strings.Contains(errOut.String(), "private-output-value") || !strings.Contains(errOut.String(), "output_failed") {
			t.Fatal("help output failure accepted")
		}
		if writeJSON(writer, Report{Status: "page_complete"}) == nil {
			t.Fatal("short/failed report accepted")
		}
	}
}
