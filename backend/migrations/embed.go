package migrations

import "embed"

// Files are immutable SQL migration inputs embedded into the migration binary.
//
//go:embed *.sql
var Files embed.FS
