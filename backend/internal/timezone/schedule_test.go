package timezone

import (
	"errors"
	"testing"
	"time"
)

func TestExplicitFoldAndFractionalOffsets(t *testing.T) {
	for _, tc := range []struct {
		local, zone string
		offset      int
		utc         string
	}{
		{"2026-11-01T01:30:00.123456", "America/New_York", -14400, "2026-11-01T05:30:00.123456Z"},
		{"2026-11-01T01:30:00.123456", "America/New_York", -18000, "2026-11-01T06:30:00.123456Z"},
		{"2026-04-05T01:45:00", "Australia/Lord_Howe", 39600, "2026-04-04T14:45:00Z"},
		{"2026-04-05T01:45:00", "Australia/Lord_Howe", 37800, "2026-04-04T15:15:00Z"},
		{"2026-10-02T12:00:00.1", "Asia/Kathmandu", 20700, "2026-10-02T06:15:00.1Z"},
		{"0001-01-01T00:00:00", "UTC", 0, "0001-01-01T00:00:00Z"},
		{"9999-12-31T23:59:59.999999", "UTC", 0, "9999-12-31T23:59:59.999999Z"},
	} {
		t.Run(tc.zone+tc.utc, func(t *testing.T) {
			instant, local, err := Resolve(tc.local, tc.zone, &tc.offset)
			if err != nil || instant.Format(time.RFC3339Nano) != tc.utc || local != tc.local {
				t.Fatal("schedule changed intent", instant, local, err)
			}
		})
	}
}
func TestGapsMismatchesAndInvalidSchedulesFail(t *testing.T) {
	for _, tc := range []struct {
		local, zone string
		offset      int
	}{
		{"2026-03-08T02:30:00", "America/New_York", -14400},
		{"2026-03-08T02:30:00", "America/New_York", -18000},
		{"2026-10-04T02:15:00", "Australia/Lord_Howe", 37800},
		{"2026-10-04T02:15:00", "Australia/Lord_Howe", 39600},
		{"2011-12-30T12:00:00", "Pacific/Apia", -36000},
		{"2011-12-30T12:00:00", "Pacific/Apia", 50400},
		{"2026-10-02T12:00:00", "Asia/Kathmandu", 19800},
		{"2026-02-30T12:00:00", "UTC", 0},
		{"2026-10-02T24:00:00", "UTC", 0},
		{"2026-10-02T12:00:60", "UTC", 0},
		{"2026-10-02T12:00:00.1234567", "UTC", 0},
		{"2026-10-02T12:00", "UTC", 0},
		{"2026-10-02T12:00:00Z", "UTC", 0},
		{"2026-10-02T12:00:00", "Local", 0},
		{"2026-10-02T12:00:00", "GMT+02:00", 7200},
		{"2026-10-02T12:00:00", "../../etc/passwd", 0},
		{"2026-10-02T12:00:00", "Unknown/Zone", 0},
		{"0000-01-01T00:00:00", "UTC", 0},
		{"0001-01-01T00:00:00", "Etc/GMT-1", 3600},
		{"9999-12-31T23:59:59", "Etc/GMT+1", -3600},
	} {
		if _, _, err := Resolve(tc.local, tc.zone, &tc.offset); !errors.Is(err, ErrSchedule) {
			t.Fatalf("invalid schedule accepted: %+v", tc)
		}
	}
	if _, _, err := Resolve("2026-11-01T01:30:00", "America/New_York", nil); !errors.Is(err, ErrSchedule) {
		t.Fatal("missing fold choice accepted")
	}
}
