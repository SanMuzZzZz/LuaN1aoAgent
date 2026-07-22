package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const schemaVersion = 4

type Store struct {
	db          *sql.DB
	blobDir     string
	quota       int64
	exchangeCap int64
	mu          sync.Mutex
}

type Audit struct {
	Started, Completed                                             time.Time
	Method, URL, Host, Scheme, Protocol, Mode                      string
	Status                                                         int
	ReqObserved, RespObserved, ReqCaptured, RespCaptured           int64
	ReqBlob, RespBlob                                              string
	ReqState, RespState                                            string
	ReqTruncated, RespTruncated                                    bool
	ReqTruncationReason, RespTruncationReason                      string
	HeaderTruncated                                                bool
	HeaderTruncationReason                                         string
	Err                                                            string
	RuntimeRef, TaskRef, RunRef, Attribution, RouteRef, SessionRef string
	RequestHeaders, ResponseHeaders                                http.Header
	ConnectRef, ConnectAuthority, ConnectHost, ConnectPort         string
	QuotaPressure                                                  bool
	EvictedExchanges                                               int64
	ReplayOf                                                       int64
	ErrorCode                                                      string
}

func OpenStore(dir string, quota int64, exchangeCap ...int64) (*Store, error) {
	if err := securePrivateDir(dir); err != nil {
		return nil, err
	}
	blobDir := filepath.Join(dir, "blobs")
	if err := securePrivateDir(blobDir); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dir, "traffic.sqlite")
	if err := requireRegularOrAbsent(dbPath); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		db.Close()
		return nil, err
	}
	cap := int64(0)
	if len(exchangeCap) > 0 {
		cap = exchangeCap[0]
	}
	s := &Store{db: db, blobDir: blobDir, quota: quota, exchangeCap: cap}
	if err = s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(dbPath, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return errors.New("traffic database schema is newer than this binary")
	}
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS exchanges(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 started_at TEXT NOT NULL, completed_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
 method TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, scheme TEXT NOT NULL,
 protocol TEXT NOT NULL, mode TEXT NOT NULL, status INTEGER NOT NULL,
 request_observed_bytes INTEGER NOT NULL, response_observed_bytes INTEGER NOT NULL,
 request_captured_bytes INTEGER NOT NULL, response_captured_bytes INTEGER NOT NULL,
 request_body_ref TEXT, response_body_ref TEXT,
 request_capture_state TEXT NOT NULL, response_capture_state TEXT NOT NULL,
 request_truncated INTEGER NOT NULL, response_truncated INTEGER NOT NULL,
 request_truncation_reason TEXT, response_truncation_reason TEXT,
 headers_truncated INTEGER NOT NULL, header_truncation_reason TEXT,
 error TEXT, runtime_ref TEXT, task_ref TEXT, run_ref TEXT, attribution TEXT,
 route_ref TEXT, session_ref TEXT,
 connect_ref TEXT, connect_authority TEXT, connect_host TEXT, connect_port TEXT,
 quota_pressure INTEGER NOT NULL DEFAULT 0, evicted_exchanges INTEGER NOT NULL DEFAULT 0,
 replay_of INTEGER REFERENCES exchanges(id), error_code TEXT
);
CREATE TABLE IF NOT EXISTS exchange_headers(
 exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
 side TEXT NOT NULL CHECK(side IN ('request','response')),
 ordinal INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(exchange_id,side,ordinal)
);
CREATE INDEX IF NOT EXISTS exchanges_started ON exchanges(started_at);
CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session_ref);
CREATE INDEX IF NOT EXISTS exchanges_task_run ON exchanges(task_ref,run_ref);`); err != nil {
		return err
	}
	if version < 2 {
		var exists int
		if err = tx.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='traffic'`).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			_, err = tx.Exec(`INSERT INTO exchanges(started_at,completed_at,duration_ms,method,url,host,scheme,protocol,mode,status,
request_observed_bytes,response_observed_bytes,request_captured_bytes,response_captured_bytes,request_body_ref,response_body_ref,
request_capture_state,response_capture_state,request_truncated,response_truncated,headers_truncated,error,attribution,route_ref,session_ref)
SELECT started_at,started_at,duration_ms,method,url,host,scheme,'HTTP/1.1',CASE WHEN tunnel=1 THEN 'connect' ELSE 'forward' END,status,
request_bytes,response_bytes,0,0,request_blob,response_blob,CASE WHEN request_blob IS NULL THEN 'none' ELSE 'legacy' END,CASE WHEN response_blob IS NULL THEN 'none' ELSE 'legacy' END,0,0,0,error,attribution,route,session FROM traffic`)
			if err != nil {
				return err
			}
		}
	}
	for _, column := range []struct {
		name string
		decl string
	}{
		{"connect_ref", "TEXT"},
		{"replay_of", "INTEGER REFERENCES exchanges(id)"},
		{"error_code", "TEXT"},
	} {
		exists, columnErr := sqliteColumnExists(tx, "exchanges", column.name)
		if columnErr != nil {
			return columnErr
		}
		if !exists {
			if _, err = tx.Exec(`ALTER TABLE exchanges ADD COLUMN ` + column.name + ` ` + column.decl); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec(`CREATE INDEX IF NOT EXISTS exchanges_connect_ref ON exchanges(connect_ref);
CREATE INDEX IF NOT EXISTS exchanges_replay_of ON exchanges(replay_of);
PRAGMA user_version=4`); err != nil {
		return err
	}
	return tx.Commit()
}

func sqliteColumnExists(tx *sql.Tx, table, column string) (bool, error) {
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, kind string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Close()
}
func (s *Store) PutBlob(data []byte) (string, error) {
	if len(data) == 0 {
		return "", nil
	}
	h := sha256.Sum256(data)
	name := hex.EncodeToString(h[:])
	path := filepath.Join(s.blobDir, name[:2], name)
	if _, err := os.Stat(path); err == nil {
		return name, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(data)
	}
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(tmp.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	return name, nil
}

func (s *Store) Record(a Audit) error {
	_, err := s.RecordWithID(a)
	return err
}

func (s *Store) RecordWithID(a Audit) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO exchanges(started_at,completed_at,duration_ms,method,url,host,scheme,protocol,mode,status,request_observed_bytes,response_observed_bytes,request_captured_bytes,response_captured_bytes,request_body_ref,response_body_ref,request_capture_state,response_capture_state,request_truncated,response_truncated,request_truncation_reason,response_truncation_reason,headers_truncated,header_truncation_reason,error,runtime_ref,task_ref,run_ref,attribution,route_ref,session_ref,connect_ref,connect_authority,connect_host,connect_port,quota_pressure,evicted_exchanges,replay_of,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.Started.UTC().Format(time.RFC3339Nano), a.Completed.UTC().Format(time.RFC3339Nano), a.Completed.Sub(a.Started).Milliseconds(), a.Method, a.URL, a.Host, a.Scheme, a.Protocol, a.Mode, a.Status, a.ReqObserved, a.RespObserved, a.ReqCaptured, a.RespCaptured, null(a.ReqBlob), null(a.RespBlob), a.ReqState, a.RespState, boolInt(a.ReqTruncated), boolInt(a.RespTruncated), null(a.ReqTruncationReason), null(a.RespTruncationReason), boolInt(a.HeaderTruncated), null(a.HeaderTruncationReason), null(a.Err), null(a.RuntimeRef), null(a.TaskRef), null(a.RunRef), null(a.Attribution), null(a.RouteRef), null(a.SessionRef), null(a.ConnectRef), null(a.ConnectAuthority), null(a.ConnectHost), null(a.ConnectPort), 0, 0, nullInt64(a.ReplayOf), null(a.ErrorCode))
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	ordinal := 0
	for _, side := range []struct {
		name string
		h    http.Header
	}{{"request", a.RequestHeaders}, {"response", a.ResponseHeaders}} {
		for name, values := range side.h {
			for _, value := range values {
				if _, err = tx.Exec(`INSERT INTO exchange_headers(exchange_id,side,ordinal,name,value) VALUES(?,?,?,?,?)`, id, side.name, ordinal, name, value); err != nil {
					return 0, err
				}
				ordinal++
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	evicted, pressure, err := s.rotate(id)
	if err != nil {
		return 0, err
	}
	if pressure || evicted > 0 {
		_, err = s.db.Exec(`UPDATE exchanges SET quota_pressure=?,evicted_exchanges=? WHERE id=?`, boolInt(pressure), evicted, id)
	}
	return id, err
}

func (s *Store) rotate(current int64) (int64, bool, error) {
	var evicted int64
	for {
		var count int64
		if err := s.db.QueryRow(`SELECT count(*) FROM exchanges`).Scan(&count); err != nil {
			return evicted, false, err
		}
		sz, err := treeSize(filepath.Dir(s.blobDir))
		if err != nil {
			return evicted, false, err
		}
		overCount := s.exchangeCap > 0 && count > s.exchangeCap
		overQuota := s.quota > 0 && sz > s.quota
		if !overCount && !overQuota {
			return evicted, false, nil
		}
		var id int64
		var rb, sb sql.NullString
		err = s.db.QueryRow(`SELECT e.id,e.request_body_ref,e.response_body_ref FROM exchanges e WHERE e.id<>? AND NOT EXISTS (SELECT 1 FROM exchanges child WHERE child.replay_of=e.id) ORDER BY e.id LIMIT 1`, current).Scan(&id, &rb, &sb)
		if errors.Is(err, sql.ErrNoRows) {
			return evicted, true, nil
		}
		if err != nil {
			return evicted, false, err
		}
		if _, err = s.db.Exec(`DELETE FROM exchanges WHERE id=?`, id); err != nil {
			return evicted, false, err
		}
		evicted++
		for _, b := range []sql.NullString{rb, sb} {
			if b.Valid {
				s.deleteUnreferenced(b.String)
			}
		}
	}
}
func (s *Store) deleteUnreferenced(hash string) {
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM exchanges WHERE request_body_ref=? OR response_body_ref=?`, hash, hash).Scan(&n)
	if n == 0 && len(hash) >= 2 {
		_ = os.Remove(filepath.Join(s.blobDir, hash[:2], hash))
	}
}
func null(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func nullInt64(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}
func (s *Store) ReadBlob(ref string, limit int64) ([]byte, error) {
	if len(ref) != 64 {
		return nil, errors.New("body not captured")
	}
	f, err := os.Open(filepath.Join(s.blobDir, ref[:2], ref))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, truncated, err := readLimited(f, limit)
	if err != nil {
		return nil, err
	}
	if truncated {
		return nil, errors.New("captured body exceeds replay limit")
	}
	return data, nil
}
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func treeSize(root string) (int64, error) {
	var n int64
	err := filepath.Walk(root, func(_ string, i os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if !i.IsDir() {
			n += i.Size()
		}
		return nil
	})
	return n, err
}
func readLimited(r io.Reader, limit int64) ([]byte, bool, error) {
	if r == nil {
		return nil, false, nil
	}
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > limit {
		return b[:limit], true, nil
	}
	return b, false, nil
}
