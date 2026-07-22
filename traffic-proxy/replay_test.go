package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func replaySource(t *testing.T, store *Store, target string, body []byte, headers http.Header) int64 {
	t.Helper()
	now := time.Now()
	a := Audit{Started: now, Completed: now, Method: "POST", URL: target, Host: strings.TrimPrefix(target, "http://"), Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", Status: 200, ReqObserved: int64(len(body)), ReqCaptured: int64(len(body)), ReqState: "none", RespState: "none", RequestHeaders: headers}
	if len(body) > 0 {
		var err error
		a.ReqBlob, err = store.PutBlob(body)
		if err != nil {
			t.Fatal(err)
		}
		a.ReqState = "captured"
	}
	id, err := store.RecordWithID(a)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func replayContext() *Context {
	return &Context{RuntimeRef: "runtime", TaskRef: "task-replay", RunRef: "run-replay", Attribution: "manual-replay", RouteRef: "route-context", SessionRef: "session-context"}
}

func replayCode(err error) string {
	var replayErr *ReplayError
	if errors.As(err, &replayErr) {
		return replayErr.Code
	}
	return ""
}

func TestReplayMigrationFromSchemaVersionThreeIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "traffic.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE exchanges(
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
 route_ref TEXT, session_ref TEXT, connect_ref TEXT, connect_authority TEXT,
 connect_host TEXT, connect_port TEXT, quota_pressure INTEGER NOT NULL DEFAULT 0,
 evicted_exchanges INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE exchange_headers(exchange_id INTEGER NOT NULL, side TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(exchange_id,side,ordinal));
PRAGMA user_version=3`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	first, err := OpenStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := OpenStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for _, column := range []string{"replay_of", "error_code"} {
		exists, checkErr := func() (bool, error) {
			tx, beginErr := second.db.Begin()
			if beginErr != nil {
				return false, beginErr
			}
			defer tx.Rollback()
			return sqliteColumnExists(tx, "exchanges", column)
		}()
		if checkErr != nil || !exists {
			t.Fatalf("column %s exists=%v err=%v", column, exists, checkErr)
		}
	}
	var version int
	if err = second.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version=%d err=%v", version, err)
	}
}

func TestReplaySuccessOverridesBodyDuplicateHeadersAndAttribution(t *testing.T) {
	type observedRequest struct {
		method string
		body   string
		values []string
	}
	seen := make(chan observedRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen <- observedRequest{method: r.Method, body: string(body), values: r.Header.Values("X-Repeat")}
		w.Header().Set("X-Upstream", "ok")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("replayed"))
	}))
	defer upstream.Close()
	store := testStore(t)
	sourceID := replaySource(t, store, upstream.URL+"/source", []byte("source-body"), http.Header{"X-Source": {"keep"}})
	sourceBefore, _ := store.HistoryGet(sourceID)
	p := &Proxy{Store: store, State: NewState("runtime"), CaptureLimit: 1024, HeaderLimit: 1024}
	headers := []HeaderEntry{{Name: "X-Repeat", Value: "one"}, {Name: "X-Repeat", Value: "two"}}
	ctx := replayContext()
	result, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: sourceID, Method: "PUT", URL: upstream.URL + "/override", Headers: &headers, Body: &ReplayBody{Encoding: "base64", Data: base64.StdEncoding.EncodeToString([]byte("override-body"))}, RouteRef: "route-command", SessionRef: "session-command", Context: ctx})
	if err != nil {
		t.Fatal(err)
	}
	got := <-seen
	if got.method != "PUT" || got.body != "override-body" || fmt.Sprint(got.values) != "[one two]" {
		t.Fatalf("upstream request=%#v", got)
	}
	replayed, err := store.HistoryGet(result.ExchangeID)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.ReplayOf != sourceID || replayed.Status != http.StatusCreated || replayed.ErrorCode != "" || replayed.Mode != "replay" {
		t.Fatalf("replay audit=%#v", replayed)
	}
	if replayed.RuntimeRef != ctx.RuntimeRef || replayed.TaskRef != ctx.TaskRef || replayed.RunRef != ctx.RunRef || replayed.Attribution != ctx.Attribution || replayed.RouteRef != "route-command" || replayed.SessionRef != "session-command" {
		t.Fatalf("replay attribution=%#v", replayed)
	}
	requestBody, err := store.HistoryBody(result.ExchangeID, "request", 1024)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(requestBody["data"].(string))
	if string(decoded) != "override-body" {
		t.Fatalf("stored replay body=%q", decoded)
	}
	sourceAfter, _ := store.HistoryGet(sourceID)
	if sourceBefore.ReplayOf != sourceAfter.ReplayOf || sourceBefore.Method != sourceAfter.Method || sourceBefore.URL != sourceAfter.URL || sourceBefore.RuntimeRef != sourceAfter.RuntimeRef {
		t.Fatalf("source exchange changed: before=%#v after=%#v", sourceBefore, sourceAfter)
	}
}

func TestReplaySanitizesCapturedHopByHopHeaders(t *testing.T) {
	seen := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	store := testStore(t)
	sourceHeaders := http.Header{
		"Connection":       {"X-Hop"},
		"Keep-Alive":       {"timeout=5"},
		"Proxy-Connection": {"keep-alive"},
		"X-Hop":            {"secret"},
		"X-Keep":           {"preserved"},
	}
	sourceID := replaySource(t, store, upstream.URL+"/source", nil, sourceHeaders)
	p := &Proxy{Store: store, State: NewState("runtime")}
	result, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: sourceID, Context: replayContext()})
	if err != nil {
		t.Fatal(err)
	}
	got := <-seen
	for _, name := range []string{"Connection", "Keep-Alive", "Proxy-Connection", "X-Hop"} {
		if got.Get(name) != "" {
			t.Fatalf("upstream retained %s=%q", name, got.Get(name))
		}
	}
	if got.Get("X-Keep") != "preserved" {
		t.Fatalf("upstream X-Keep=%q", got.Get("X-Keep"))
	}
	replayed, err := store.HistoryGet(result.ExchangeID)
	if err != nil {
		t.Fatal(err)
	}
	stored := headersFromEntries(replayed.RequestHeaders)
	for _, name := range []string{"Connection", "Keep-Alive", "Proxy-Connection", "X-Hop"} {
		if stored.Get(name) != "" {
			t.Fatalf("audit retained %s=%q", name, stored.Get(name))
		}
	}
}

func TestReplayRejectsDangerousTargetsAndHeadersWithStableCodes(t *testing.T) {
	store := testStore(t)
	sourceID := replaySource(t, store, "http://example.test/path", nil, nil)
	p := &Proxy{Store: store, State: NewState("runtime"), Self: []string{"127.0.0.1:8080"}}
	tests := []struct {
		name    string
		request ReplayRequest
		code    string
	}{
		{"file URL", ReplayRequest{ExchangeID: sourceID, URL: "file:///tmp/x", Context: replayContext()}, "invalid_url"},
		{"unix URL", ReplayRequest{ExchangeID: sourceID, URL: "unix:///tmp/control.sock", Context: replayContext()}, "invalid_url"},
		{"self loop", ReplayRequest{ExchangeID: sourceID, URL: "http://127.0.0.1:8080/x", Context: replayContext()}, "self_loop"},
		{"proxy authorization", ReplayRequest{ExchangeID: sourceID, Headers: headerEntries("Proxy-Authorization", "secret"), Context: replayContext()}, "forbidden_header"},
		{"proxy connection", ReplayRequest{ExchangeID: sourceID, Headers: headerEntries("Proxy-Connection", "keep-alive"), Context: replayContext()}, "forbidden_header"},
		{"connection", ReplayRequest{ExchangeID: sourceID, Headers: headerEntries("Connection", "X-Hop"), Context: replayContext()}, "forbidden_header"},
		{"host conflict", ReplayRequest{ExchangeID: sourceID, Headers: headerEntries("Host", "other.test"), Context: replayContext()}, "host_conflict"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := p.Replay(context.Background(), test.request)
			if replayCode(err) != test.code || result.ExchangeID == 0 || result.ErrorCode != test.code {
				t.Fatalf("result=%#v code=%q err=%v", result, replayCode(err), err)
			}
			x, getErr := store.HistoryGet(result.ExchangeID)
			if getErr != nil || x.ReplayOf != sourceID || x.ErrorCode != test.code {
				t.Fatalf("failure audit=%#v err=%v", x, getErr)
			}
		})
	}
}

func headerEntries(name, value string) *[]HeaderEntry {
	entries := []HeaderEntry{{Name: name, Value: value}}
	return &entries
}

func TestReplayRejectsMetadataTruncatedAndMissingBodies(t *testing.T) {
	store := testStore(t)
	now := time.Now()
	cases := []Audit{
		{Started: now, Completed: now, Method: "CONNECT", URL: "example.test:443", Host: "example.test:443", Scheme: "connect", Protocol: "HTTP/1.1", Mode: "connect_mitm", ReqState: "metadata_only", RespState: "metadata_only"},
		{Started: now, Completed: now, Method: "POST", URL: "http://example.test/", Host: "example.test", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", ReqObserved: 2, ReqCaptured: 1, ReqState: "truncated", ReqTruncated: true, RespState: "none"},
		{Started: now, Completed: now, Method: "POST", URL: "http://example.test/", Host: "example.test", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", ReqObserved: 2, ReqCaptured: 0, ReqState: "none", RespState: "none"},
	}
	p := &Proxy{Store: store, State: NewState("runtime")}
	for _, audit := range cases {
		id, err := store.RecordWithID(audit)
		if err != nil {
			t.Fatal(err)
		}
		result, replayErr := p.Replay(context.Background(), ReplayRequest{ExchangeID: id, Context: replayContext()})
		if replayCode(replayErr) != "source_not_replayable" || result.ExchangeID == 0 {
			t.Fatalf("id=%d result=%#v err=%v", id, result, replayErr)
		}
	}
}

func TestReplayConcurrencyTimeoutTLSAndResponseCaptureCodes(t *testing.T) {
	store := testStore(t)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	blocking := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-release
		_, _ = w.Write([]byte("ok"))
	}))
	defer blocking.Close()
	blockingID := replaySource(t, store, blocking.URL, nil, nil)
	p := &Proxy{Store: store, State: NewState("runtime"), ReplayLimit: 1, ReplayTimeout: time.Second, CaptureLimit: 8}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = p.Replay(context.Background(), ReplayRequest{ExchangeID: blockingID, Context: replayContext()})
	}()
	<-started
	busy, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: blockingID, Context: replayContext()})
	if replayCode(err) != "replay_busy" || busy.ErrorCode != "replay_busy" {
		t.Fatalf("busy=%#v err=%v", busy, err)
	}
	close(release)
	wg.Wait()

	timeoutServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
	}))
	defer timeoutServer.Close()
	timeoutID := replaySource(t, store, timeoutServer.URL, nil, nil)
	p.ReplayTimeout = 10 * time.Millisecond
	timedOut, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: timeoutID, Context: replayContext()})
	if replayCode(err) != "timeout" || timedOut.ErrorCode != "timeout" {
		t.Fatalf("timeout=%#v err=%v", timedOut, err)
	}

	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer tlsServer.Close()
	tlsID := replaySource(t, store, tlsServer.URL, nil, nil)
	p.ReplayTimeout = time.Second
	tlsResult, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: tlsID, Context: replayContext()})
	if replayCode(err) != "tls_error" || tlsResult.ErrorCode != "tls_error" {
		t.Fatalf("tls=%#v err=%v", tlsResult, err)
	}

	largeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 32))
	}))
	defer largeServer.Close()
	largeID := replaySource(t, store, largeServer.URL, nil, nil)
	captured, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: largeID, Context: replayContext()})
	if err != nil {
		t.Fatal(err)
	}
	x, err := store.HistoryGet(captured.ExchangeID)
	if err != nil || !x.ResponseTruncated || x.ResponseCapturedBytes != 8 {
		t.Fatalf("capture audit=%#v err=%v", x, err)
	}
}
