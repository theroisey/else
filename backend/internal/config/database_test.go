package config

import (
	"strings"
	"testing"
)

func TestDatabaseConfigurationValidation(t *testing.T) {
	for _, value := range []string{
		"postgres://tester:fake-password@127.0.0.1:5432/demo?sslmode=disable",
		"postgresql://tester:fake-password@[::1]:5432/demo?sslmode=disable",
		"postgres://tester:fake-password@database.example:5432/demo?sslmode=verify-full",
	} {
		if _, err := LoadDatabase(environment(map[string]string{"DATABASE_URL": value}), "DATABASE_URL"); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{
		"", "secret-value", "https://secret-value@localhost:5432/db", "postgres://tester@localhost:5432/db?sslmode=disable",
		"postgres://tester:secret-value@localhost/db?sslmode=disable", "postgres://tester:secret-value@localhost:5432/?sslmode=disable",
		"postgres://tester:secret-value@remote.example:5432/db?sslmode=disable", "postgres://tester:secret-value@localhost:5432/db",
		"postgres://tester:secret-value@localhost:5432/db?sslmode=prefer", "postgres://tester:secret-value@localhost:5432/db?sslmode=verify-full&sslmode=disable",
		"postgres://tester:secret-value@localhost:5432/db?sslmode=disable&password=override", "postgres://tester:secret-value@localhost:5432/db?sslmode=disable&service=override",
		"postgres://tester:secret-value@localhost:5432/db?sslmode=disable&sslrootcert=", "postgres://tester:secret-value@localhost:5432/db#secret-value",
	} {
		_, err := LoadDatabase(environment(map[string]string{"DATABASE_URL": value}), "DATABASE_URL")
		if err == nil || strings.Contains(err.Error(), "secret-value") {
			t.Fatal("unsafe database configuration validation")
		}
	}
}
