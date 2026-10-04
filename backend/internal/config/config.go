package config

import (
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"time"
)

// Config contains only the settings needed by the HTTP foundation.
type Config struct {
	Address           string
	LogLevel          slog.Level
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	RequestTimeout    time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
	ReadinessTimeout  time.Duration
	MaxHeaderBytes    int
}

func Load(lookup func(string) (string, bool)) (Config, error) {
	c := Config{
		Address: "127.0.0.1:8080", LogLevel: slog.LevelInfo,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
		RequestTimeout:  5 * time.Second,
		ShutdownTimeout: 10 * time.Second, ReadinessTimeout: 2 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	if value, ok := lookup("HTTP_ADDRESS"); ok {
		c.Address = value
	}
	if value, ok := lookup("LOG_LEVEL"); ok {
		switch value {
		case "debug":
			c.LogLevel = slog.LevelDebug
		case "info":
			c.LogLevel = slog.LevelInfo
		case "warn":
			c.LogLevel = slog.LevelWarn
		case "error":
			c.LogLevel = slog.LevelError
		default:
			return Config{}, fmt.Errorf("LOG_LEVEL must be debug, info, warn, or error")
		}
	}
	for _, setting := range []struct {
		name string
		dest *time.Duration
	}{
		{"HTTP_READ_HEADER_TIMEOUT", &c.ReadHeaderTimeout},
		{"HTTP_READ_TIMEOUT", &c.ReadTimeout},
		{"HTTP_WRITE_TIMEOUT", &c.WriteTimeout},
		{"HTTP_REQUEST_TIMEOUT", &c.RequestTimeout},
		{"HTTP_IDLE_TIMEOUT", &c.IdleTimeout},
		{"HTTP_SHUTDOWN_TIMEOUT", &c.ShutdownTimeout},
		{"HTTP_READINESS_TIMEOUT", &c.ReadinessTimeout},
	} {
		if value, ok := lookup(setting.name); ok {
			parsed, err := time.ParseDuration(value)
			if err != nil || parsed <= 0 || parsed > 5*time.Minute {
				return Config{}, fmt.Errorf("%s must be a duration greater than zero and at most 5m", setting.name)
			}
			*setting.dest = parsed
		}
	}
	if value, ok := lookup("HTTP_MAX_HEADER_BYTES"); ok {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("HTTP_MAX_HEADER_BYTES must be an integer between 1024 and 65536")
		}
		c.MaxHeaderBytes = parsed
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Validate deliberately excludes raw setting values from its errors.
func (c Config) Validate() error {
	host, port, err := net.SplitHostPort(c.Address)
	if err != nil || (host != "" && host != "localhost" && net.ParseIP(host) == nil) {
		return fmt.Errorf("HTTP_ADDRESS must contain an IP address or localhost and a numeric port")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return fmt.Errorf("HTTP_ADDRESS port must be between 1 and 65535")
	}
	for _, digit := range port {
		if digit < '0' || digit > '9' {
			return fmt.Errorf("HTTP_ADDRESS port must contain only decimal digits")
		}
	}
	switch c.LogLevel {
	case slog.LevelDebug, slog.LevelInfo, slog.LevelWarn, slog.LevelError:
	default:
		return fmt.Errorf("LOG_LEVEL must be debug, info, warn, or error")
	}
	for _, setting := range []struct {
		name  string
		value time.Duration
	}{
		{"HTTP_READ_HEADER_TIMEOUT", c.ReadHeaderTimeout},
		{"HTTP_READ_TIMEOUT", c.ReadTimeout},
		{"HTTP_WRITE_TIMEOUT", c.WriteTimeout},
		{"HTTP_REQUEST_TIMEOUT", c.RequestTimeout},
		{"HTTP_IDLE_TIMEOUT", c.IdleTimeout},
		{"HTTP_SHUTDOWN_TIMEOUT", c.ShutdownTimeout},
		{"HTTP_READINESS_TIMEOUT", c.ReadinessTimeout},
	} {
		if setting.value <= 0 || setting.value > 5*time.Minute {
			return fmt.Errorf("%s must be greater than zero and at most 5m", setting.name)
		}
	}
	if c.ReadHeaderTimeout > c.ReadTimeout {
		return fmt.Errorf("HTTP_READ_HEADER_TIMEOUT must not exceed HTTP_READ_TIMEOUT")
	}
	if c.ReadinessTimeout >= c.WriteTimeout {
		return fmt.Errorf("HTTP_READINESS_TIMEOUT must be less than HTTP_WRITE_TIMEOUT")
	}
	if c.RequestTimeout >= c.WriteTimeout {
		return fmt.Errorf("HTTP_REQUEST_TIMEOUT must be less than HTTP_WRITE_TIMEOUT")
	}
	if c.ReadinessTimeout >= c.RequestTimeout {
		return fmt.Errorf("HTTP_READINESS_TIMEOUT must be less than HTTP_REQUEST_TIMEOUT")
	}
	if c.MaxHeaderBytes < 1024 || c.MaxHeaderBytes > 65536 {
		return fmt.Errorf("HTTP_MAX_HEADER_BYTES must be between 1024 and 65536")
	}
	return nil
}
