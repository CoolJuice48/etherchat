// Package store opens the SQLite database and applies migrations.
//
// Writes go through a single connection so they serialize; reads use a
// separate pool. Both run in WAL mode.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

// DB holds the write connection and the read pool.
type DB struct {
	w *sql.DB
	r *sql.DB
}

// Open opens (creating if needed) the database at path and applies migrations.
func Open(ctx context.Context, path string) (*DB, error) {
	w, err := sql.Open("sqlite", dsn(path, true))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite", dsn(path, false))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	db := &DB{w: w, r: r}
	if err := db.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func dsn(path string, write bool) string {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	if write {
		q.Set("_txlock", "immediate")
	} else {
		q.Add("_pragma", "query_only(1)")
	}
	return "file:" + path + "?" + q.Encode()
}

// Close closes both connections.
func (db *DB) Close() error {
	err := db.r.Close()
	if werr := db.w.Close(); err == nil {
		err = werr
	}
	return err
}

// Read returns the read pool for queries outside a write transaction.
func (db *DB) Read() *sql.DB { return db.r }

// Tx runs fn in a write transaction, committing if fn returns nil.
func (db *DB) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// VacuumInto writes a compact, consistent copy of the database to path,
// which must not exist. It's SQLite's online backup: writers wait briefly,
// readers don't.
func (db *DB) VacuumInto(ctx context.Context, path string) error {
	_, err := db.w.ExecContext(ctx, `VACUUM INTO ?`, path)
	return err
}

// ReadTx runs fn in a read-only transaction so it sees one consistent snapshot.
func (db *DB) ReadTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.r.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return fn(tx)
}

func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.w.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return err
	}
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	type mig struct {
		version int
		name    string
	}
	var all []mig
	for _, f := range files {
		base := strings.TrimPrefix(f, "migrations/")
		n, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: name must start with a number", base)
		}
		all = append(all, mig{n, f})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].version < all[j].version })

	for _, m := range all {
		var done int
		if err := db.w.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&done); err != nil {
			return err
		}
		if done > 0 {
			continue
		}
		body, err := migrations.ReadFile(m.name)
		if err != nil {
			return err
		}
		err = db.Tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
				m.version, time.Now().UnixMilli())
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
	}
	return nil
}
