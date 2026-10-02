// Package timezone validates explicit IANA wall clocks without choosing a DST fold.
package timezone

import (
	"errors"
	"regexp"
	"time"
	_ "time/tzdata" // Minimal runtime images need the IANA database too.
)

var ErrSchedule = errors.New("invalid timezone or local schedule")

const LocalLayout = "2006-01-02T15:04:05.999999"

var namePattern = regexp.MustCompile(`^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$`)
var localPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$`)

func ValidName(name string) bool {
	if len(name) > 100 || !namePattern.MatchString(name) {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

// Resolve requires an explicit offset even for UTC. Both repeated-hour instants
// are supported; gaps and offsets inconsistent with the named zone fail closed.
func Resolve(local, name string, offset *int) (time.Time, string, error) {
	if offset == nil || *offset <= -86400 || *offset >= 86400 || !localPattern.MatchString(local) || !ValidName(name) {
		return time.Time{}, "", ErrSchedule
	}
	wall, err := time.Parse(LocalLayout, local)
	if err != nil || wall.Year() < 1 || wall.Year() > 9999 {
		return time.Time{}, "", ErrSchedule
	}
	instant := wall.Add(-time.Duration(*offset) * time.Second).UTC()
	if instant.Year() < 1 || instant.Year() > 9999 {
		return time.Time{}, "", ErrSchedule
	}
	location, _ := time.LoadLocation(name)
	zoned := instant.In(location)
	_, actual := zoned.Zone()
	if actual != *offset || zoned.Format(LocalLayout) != wall.Format(LocalLayout) {
		return time.Time{}, "", ErrSchedule
	}
	return instant, wall.Format(LocalLayout), nil
}
