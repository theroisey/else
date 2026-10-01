package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Database contains only connection settings. Never log or format this value.
type Database struct {
	URL            string
	MaxConnections int32
	ConnectTimeout time.Duration
}

func LoadDatabase(lookup func(string) (string, bool), variable string) (Database, error) {
	value, _ := lookup(variable)
	c := Database{URL: value, MaxConnections: 10, ConnectTimeout: 5 * time.Second}
	if err := c.Validate(); err != nil {
		return Database{}, fmt.Errorf("%s must be an explicit PostgreSQL URL with credentials, host, port, database, and safe TLS settings", variable)
	}
	return c, nil
}

func (c Database) Validate() error {
	invalid := func() error { return fmt.Errorf("invalid PostgreSQL connection configuration") }
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Opaque != "" || u.Fragment != "" {
		return invalid()
	}
	if u.User == nil || u.User.Username() == "" {
		return invalid()
	}
	password, ok := u.User.Password()
	if !ok || password == "" {
		return invalid()
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if host == "" || strings.ContainsAny(host, ",/\\") || err != nil || port < 1 || port > 65535 {
		return invalid()
	}
	if !strings.HasPrefix(u.Path, "/") || len(u.Path) < 2 || strings.Contains(u.Path[1:], "/") {
		return invalid()
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return invalid()
	}
	for key, values := range query {
		if (key != "sslmode" && key != "sslrootcert") || len(values) != 1 || values[0] == "" {
			return invalid()
		}
	}
	mode := query.Get("sslmode")
	ip := net.ParseIP(host)
	loopback := host == "localhost" || (ip != nil && ip.IsLoopback())
	if mode != "verify-full" && !(mode == "disable" && loopback) {
		return invalid()
	}
	if c.MaxConnections < 1 || c.MaxConnections > 50 || c.ConnectTimeout <= 0 || c.ConnectTimeout > 30*time.Second {
		return invalid()
	}
	return nil
}
