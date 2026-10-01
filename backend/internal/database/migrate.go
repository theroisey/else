package database

import (
	"context"
	"database/sql"
	"io/fs"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

func MigrationProvider(db *sql.DB, files fs.FS) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockTimeout(1, 30), lock.WithUnlockTimeout(1, 2))
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, db, files,
		goose.WithTableName("public.goose_db_version"),
		goose.WithDisableGlobalRegistry(true),
		goose.WithSessionLocker(boundedUnlock{SessionLocker: locker}),
		goose.WithLogger(safeMigrationLogger{}),
	)
}

type boundedUnlock struct{ lock.SessionLocker }

func (l boundedUnlock) SessionUnlock(ctx context.Context, conn *sql.Conn) error {
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return l.SessionLocker.SessionUnlock(bounded, conn)
}

// Goose diagnostics may contain SQL or connection details. The command reports
// safe status/version events itself and never prints raw library diagnostics.
type safeMigrationLogger struct{}

func (safeMigrationLogger) Printf(string, ...interface{}) {}
func (safeMigrationLogger) Fatalf(string, ...interface{}) { panic("migration library fatal error") }
