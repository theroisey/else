package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
)

type Auth struct {
	PublicOrigin string
	CookieSecure bool
}

func LoadAuth(lookup func(string) (string, bool)) (Auth, error) {
	c := Auth{CookieSecure: true}
	value, ok := lookup("AUTH_PUBLIC_ORIGIN")
	if !ok || value == "" {
		return Auth{}, fmt.Errorf("AUTH_PUBLIC_ORIGIN is required")
	}
	c.PublicOrigin = value
	if value, ok := lookup("AUTH_COOKIE_SECURE"); ok {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return Auth{}, fmt.Errorf("AUTH_COOKIE_SECURE must be true or false")
		}
		c.CookieSecure = parsed
	}
	if err := c.Validate(); err != nil {
		return Auth{}, err
	}
	return c, nil
}

func (c Auth) Validate() error {
	u, err := url.Parse(c.PublicOrigin)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.Path != "" ||
		u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("AUTH_PUBLIC_ORIGIN must be an exact http or https origin without credentials, path, query, or fragment")
	}
	if c.CookieSecure && u.Scheme != "https" {
		return fmt.Errorf("AUTH_PUBLIC_ORIGIN must use https when AUTH_COOKIE_SECURE is true")
	}
	if !c.CookieSecure {
		host := u.Hostname()
		if u.Scheme != "http" || (host != "localhost" && !net.ParseIP(host).IsLoopback()) {
			return fmt.Errorf("insecure authentication cookies are allowed only for an http loopback origin")
		}
	}
	return nil
}
