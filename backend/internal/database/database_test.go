package database

import (
	"testing"
	"time"

	"github.com/theroisey/else/backend/internal/config"
)

func TestConnectionSettingsIgnoreAmbientCredentialsAndSessionOptions(t *testing.T) {
	t.Setenv("PGSERVICE", "")
	t.Setenv("PGHOST", "wrong-test-host")
	t.Setenv("PGPASSWORD", "wrong-test-password")
	t.Setenv("PGOPTIONS", "-c TimeZone=Pacific/Honolulu")
	c, err := connectionConfig(config.Database{URL: "postgres://tester:fake-password@127.0.0.1:5432/demo?sslmode=disable", MaxConnections: 3, ConnectTimeout: time.Second})
	if err != nil {
		t.Fatal("explicit connection settings were overridden")
	}
	if c.Host != "127.0.0.1" || c.User != "tester" || c.Database != "demo" || c.Password != "fake-password" || c.ConnectTimeout != time.Second {
		t.Fatal("explicit connection identity was not retained")
	}
	if c.RuntimeParams["TimeZone"] != "UTC" || c.RuntimeParams["options"] != "" || c.RuntimeParams["search_path"] != "pg_catalog,app" {
		t.Fatal("unsafe session defaults")
	}
}

func TestPoolBoundsValidated(t *testing.T) {
	for _, count := range []int32{0, 51} {
		_, err := connectionConfig(config.Database{URL: "postgres://tester:fake-password@127.0.0.1:5432/demo?sslmode=disable", MaxConnections: count, ConnectTimeout: time.Second})
		if err == nil {
			t.Fatal("invalid pool bound accepted")
		}
	}
}

func TestAmbientServiceFailsClosed(t *testing.T) {
	t.Setenv("PGSERVICE", "unconfigured-test-service")
	_, err := connectionConfig(config.Database{URL: "postgres://tester:fake-password@127.0.0.1:5432/demo?sslmode=disable", MaxConnections: 3, ConnectTimeout: time.Second})
	if err == nil {
		t.Fatal("ambient service override accepted")
	}
}
