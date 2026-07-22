package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestForwardAuditAndAttribution(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(201)
		w.Write(append([]byte("reply:"), b...))
	}))
	defer up.Close()
	s := testStore(t)
	state := &State{started: time.Now(), ctx: Context{RuntimeRef: "runtime-1", Attribution: "agent", RouteRef: "r1", SessionRef: "s1"}}
	p := &Proxy{Store: s, State: state, CaptureLimit: 1024}
	r := httptest.NewRequest("POST", up.URL+"/x", strings.NewReader("body"))
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != 201 || w.Body.String() != "reply:body" {
		t.Fatalf("response %d %q", w.Code, w.Body.String())
	}
	var method, attr, route, session, rb, sb string
	var status int
	if err := s.db.QueryRow(`SELECT method,status,attribution,route_ref,session_ref,request_body_ref,response_body_ref FROM exchanges`).Scan(&method, &status, &attr, &route, &session, &rb, &sb); err != nil {
		t.Fatal(err)
	}
	if method != "POST" || status != 201 || attr != "agent" || route != "r1" || session != "s1" {
		t.Fatalf("bad audit values")
	}
	for _, h := range []string{rb, sb} {
		if _, err := os.Stat(filepath.Join(s.blobDir, h[:2], h)); err != nil {
			t.Fatal(err)
		}
	}
}
func TestRejectRelativeAndSelfTarget(t *testing.T) {
	s := testStore(t)
	p := &Proxy{Store: s, State: &State{started: time.Now()}, CaptureLimit: 10, Self: []string{"127.0.0.1:8080"}}
	for _, raw := range []string{"/relative", "http://127.0.0.1:8080/x"} {
		r := httptest.NewRequest("GET", raw, nil)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Errorf("%s: %d", raw, w.Code)
		}
	}
}
func TestBlobDedup(t *testing.T) {
	s := testStore(t)
	a, _ := s.PutBlob([]byte("same"))
	b, _ := s.PutBlob([]byte("same"))
	if a != b || len(a) != 64 {
		t.Fatalf("%q %q", a, b)
	}
}

func TestConnectIsOpaqueTunnel(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		c, e := echo.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	s := testStore(t)
	p := &Proxy{Store: s, State: &State{started: time.Now()}, Dialer: net.Dialer{Timeout: time.Second}, ConnectMode: "passthrough"}
	server := httptest.NewServer(p)
	defer server.Close()
	proxyAddr := strings.TrimPrefix(server.URL, "http://")
	c, err := net.Dial("tcp", proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", echo.Addr(), echo.Addr())
	rd := bufio.NewReader(c)
	line, err := rd.ReadString('\n')
	if err != nil || !strings.Contains(line, " 200 ") {
		t.Fatalf("%q %v", line, err)
	}
	for {
		line, err = rd.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	if _, err = c.Write([]byte("secret")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 6)
	if _, err = io.ReadFull(rd, got); err != nil || string(got) != "secret" {
		t.Fatalf("%q %v", got, err)
	}
	c.Close()
	deadline := time.Now().Add(time.Second)
	for {
		var mode string
		var req, resp int
		var rb, sb any
		err = s.db.QueryRow(`SELECT mode,request_observed_bytes,response_observed_bytes,request_body_ref,response_body_ref FROM exchanges`).Scan(&mode, &req, &resp, &rb, &sb)
		if err == nil {
			if mode != "connect_passthrough" || req != 6 || resp != 6 || rb != nil || sb != nil {
				t.Fatalf("bad tunnel audit")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestControlProtocol(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ctl.sock")
	ln, err := listenControl(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	state := &State{started: time.Now()}
	done := make(chan struct{})
	go serveControl(ln, state, func() { close(done) }, "127.0.0.1:43210")
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rd := bufio.NewReader(c)
	send := func(v any) controlResponse {
		b, _ := json.Marshal(v)
		c.Write(append(b, '\n'))
		line, err := rd.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var r controlResponse
		if err = json.Unmarshal(line, &r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := send(controlRequest{Version: 1, Command: "hello"}); !r.OK {
		t.Fatal(r)
	} else if result, ok := r.Result.(map[string]any); !ok || result["proxy"] != "127.0.0.1:43210" {
		t.Fatalf("hello proxy = %#v", r.Result)
	}
	if r := send(controlRequest{Version: 1, Command: "set", Field: "session_ref", Value: "abc"}); !r.OK {
		t.Fatal(r)
	}
	if state.Get().SessionRef != "abc" {
		t.Fatal("not set")
	}
	if r := send(controlRequest{Version: 1, Command: "clear", Field: "session_ref"}); !r.OK {
		t.Fatal(r)
	}
	if r := send(controlRequest{Version: 2, Command: "health"}); r.OK || r.Error == "" {
		t.Fatal(r)
	}
	if r := send(controlRequest{Version: 1, Command: "shutdown"}); !r.OK {
		t.Fatal(r)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown not called")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("socket mode: %v %v", info, err)
	}
}
func TestControlRejectsLongSocketPath(t *testing.T) {
	path := "/" + strings.Repeat("x", controlSocketPathMaxBytes)
	_, err := listenControl(path)
	if err == nil || !strings.Contains(err.Error(), "104 bytes; maximum is 103") {
		t.Fatalf("unexpected long-path error: %v", err)
	}
}

func TestControlRejectsUnsafeParent(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	_, err := listenControl(filepath.Join(dir, "x"))
	if err == nil {
		t.Fatal("expected rejection")
	}
}

func TestControlRejectsSymlinkParent(t *testing.T) {
	dir := t.TempDir()
	realParent := filepath.Join(dir, "real")
	if err := os.Mkdir(realParent, 0700); err != nil {
		t.Fatal(err)
	}
	linkParent := filepath.Join(dir, "link")
	if err := os.Symlink(realParent, linkParent); err != nil {
		t.Fatal(err)
	}
	if _, err := listenControl(filepath.Join(linkParent, "x")); err == nil {
		t.Fatal("expected symlink-parent rejection")
	}
}

func TestRejectsAllASCIIControlCharacters(t *testing.T) {
	if !badText("host\tname") || !badText("value\x7f") || badText("private-10.0.0.1") {
		t.Fatal("control-character validation mismatch")
	}
}

func TestStripHopRemovesConnectionTokens(t *testing.T) {
	h := http.Header{"Connection": {"X-Private, Keep-Alive"}, "X-Private": {"secret"}, "Keep-Alive": {"timeout=5"}, "X-End-To-End": {"keep"}}
	stripHop(h)
	if h.Get("X-Private") != "" || h.Get("Keep-Alive") != "" || h.Get("Connection") != "" {
		t.Fatalf("hop-by-hop headers remain: %v", h)
	}
	if h.Get("X-End-To-End") != "keep" {
		t.Fatalf("end-to-end header removed: %v", h)
	}
}

func TestReadLimited(t *testing.T) {
	b, trunc, err := readLimited(bytes.NewBufferString("abcdef"), 3)
	if err != nil || !trunc || string(b) != "abc" {
		t.Fatalf("%q %v %v", b, trunc, err)
	}
}

func TestForwardStreamsAndLimitsRequestCapture(t *testing.T) {
	const captureLimit = 1024
	body := bytes.Repeat([]byte("large-request-"), 100000)
	reads := 0
	source := &countingReader{Reader: bytes.NewReader(body), reads: &reads}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if reads != 0 {
			t.Fatal("request body was read before RoundTrip")
		}
		got, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(got, body) {
			t.Fatal("upstream received incomplete request body")
		}
		return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: http.NoBody}, nil
	})
	s := testStore(t)
	p := &Proxy{Store: s, State: &State{started: time.Now()}, Transport: transport, CaptureLimit: captureLimit}
	r := httptest.NewRequest(http.MethodPost, "http://upstream.test/upload", source)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)

	var requestBytes int64
	var requestBlob string
	if err := s.db.QueryRow(`SELECT request_observed_bytes,request_body_ref FROM exchanges`).Scan(&requestBytes, &requestBlob); err != nil {
		t.Fatal(err)
	}
	if requestBytes != int64(len(body)) {
		t.Fatalf("request bytes = %d, want %d", requestBytes, len(body))
	}
	captured, err := os.ReadFile(filepath.Join(s.blobDir, requestBlob[:2], requestBlob))
	if err != nil {
		t.Fatal(err)
	}
	if len(captured) != captureLimit || !bytes.Equal(captured, body[:captureLimit]) {
		t.Fatalf("captured %d unexpected bytes", len(captured))
	}
}

func TestControlPreservesExistingRegularFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ctl.sock")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := listenControl(path); err == nil {
		t.Fatal("expected regular-file rejection")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep" {
		t.Fatalf("regular file changed: %q", got)
	}
}

func TestCaptureLimitZeroWritesNoBlobs(t *testing.T) {
	s := testStore(t)
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("response"))}, nil
	})
	p := &Proxy{Store: s, State: &State{started: time.Now()}, Transport: transport, CaptureLimit: 0}
	r := httptest.NewRequest(http.MethodPost, "http://upstream.test/", strings.NewReader("request"))
	p.ServeHTTP(httptest.NewRecorder(), r)

	var requestBlob, responseBlob any
	if err := s.db.QueryRow(`SELECT request_body_ref,response_body_ref FROM exchanges`).Scan(&requestBlob, &responseBlob); err != nil {
		t.Fatal(err)
	}
	if requestBlob != nil || responseBlob != nil {
		t.Fatalf("unexpected blobs: request=%v response=%v", requestBlob, responseBlob)
	}
	entries, err := os.ReadDir(s.blobDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("blob directory contains %d entries", len(entries))
	}
}

type countingReader struct {
	io.Reader
	reads *int
}

func (r *countingReader) Read(p []byte) (int, error) {
	*r.reads++
	return r.Reader.Read(p)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStructuredAuditColumnsHeadersAndTruncation(t *testing.T) {
	s := testStore(t)
	state := NewState("runtime-fixed")
	for _, item := range [][2]string{{"task_ref", "task-1"}, {"run_ref", "run-1"}, {"attribution", "agent"}, {"route_ref", "route-1"}, {"session_ref", "session-1"}} {
		if err := state.Set(item[0], item[1]); err != nil {
			t.Fatal(err)
		}
	}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: 202, Header: http.Header{"Set-Cookie": {"a=1", "b=2"}, "X-Long": {"123456789"}}, Body: io.NopCloser(strings.NewReader("response-body"))}, nil
	})
	p := &Proxy{Store: s, State: state, Transport: transport, CaptureLimit: 4, HeaderLimit: 64}
	r := httptest.NewRequest("POST", "http://example.test/path", strings.NewReader("request-body"))
	r.Header["Cookie"] = []string{"a=1", "b=2"}
	r.Header.Set("Authorization", "Bearer secret")
	p.ServeHTTP(httptest.NewRecorder(), r)
	var method, rawURL, host, scheme, protocol, mode, runtimeRef, taskRef, runRef, attr, routeRef, sessionRef string
	var status, reqObserved, respObserved, reqCaptured, respCaptured, reqTrunc, respTrunc int
	var reqReason, respReason string
	if err := s.db.QueryRow(`SELECT method,url,host,scheme,protocol,mode,status,request_observed_bytes,response_observed_bytes,request_captured_bytes,response_captured_bytes,request_truncated,response_truncated,request_truncation_reason,response_truncation_reason,runtime_ref,task_ref,run_ref,attribution,route_ref,session_ref FROM exchanges`).Scan(&method, &rawURL, &host, &scheme, &protocol, &mode, &status, &reqObserved, &respObserved, &reqCaptured, &respCaptured, &reqTrunc, &respTrunc, &reqReason, &respReason, &runtimeRef, &taskRef, &runRef, &attr, &routeRef, &sessionRef); err != nil {
		t.Fatal(err)
	}
	if method != "POST" || rawURL != "http://example.test/path" || host != "example.test" || scheme != "http" || protocol != "HTTP/1.1" || mode != "forward" || status != 202 || reqObserved != 12 || respObserved != 13 || reqCaptured != 4 || respCaptured != 4 || reqTrunc != 1 || respTrunc != 1 || reqReason != "body_limit" || respReason != "body_limit" {
		t.Fatalf("unexpected exchange metadata")
	}
	if runtimeRef != "runtime-fixed" || taskRef != "task-1" || runRef != "run-1" || attr != "agent" || routeRef != "route-1" || sessionRef != "session-1" {
		t.Fatalf("unexpected scope")
	}
	var cookies, setCookies int
	if err := s.db.QueryRow(`SELECT count(*) FROM exchange_headers WHERE side='request' AND name='Cookie'`).Scan(&cookies); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM exchange_headers WHERE side='response' AND name='Set-Cookie'`).Scan(&setCookies); err != nil {
		t.Fatal(err)
	}
	if cookies != 2 || setCookies != 2 {
		t.Fatalf("duplicate headers lost: %d %d", cookies, setCookies)
	}
}

func TestHeaderLimitPersistsFlag(t *testing.T) {
	s := testStore(t)
	p := &Proxy{Store: s, State: NewState("r"), CaptureLimit: 0, HeaderLimit: 3, Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"X-Test": {"long"}}, Body: http.NoBody}, nil
	})}
	r := httptest.NewRequest("GET", "http://example.test/", nil)
	r.Header.Set("Authorization", "secret")
	p.ServeHTTP(httptest.NewRecorder(), r)
	var truncated int
	var reason string
	if err := s.db.QueryRow(`SELECT headers_truncated,header_truncation_reason FROM exchanges`).Scan(&truncated, &reason); err != nil {
		t.Fatal(err)
	}
	if truncated != 1 || reason != "header_limit" {
		t.Fatalf("%d %q", truncated, reason)
	}
}

func TestV1MigrationIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "traffic.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE traffic(id INTEGER PRIMARY KEY AUTOINCREMENT,started_at TEXT NOT NULL,duration_ms INTEGER NOT NULL,method TEXT NOT NULL,url TEXT NOT NULL,host TEXT NOT NULL,scheme TEXT NOT NULL,status INTEGER NOT NULL,request_bytes INTEGER NOT NULL,response_bytes INTEGER NOT NULL,request_blob TEXT,response_blob TEXT,error TEXT,tunnel INTEGER NOT NULL,attribution TEXT,route TEXT,session TEXT); INSERT INTO traffic(started_at,duration_ms,method,url,host,scheme,status,request_bytes,response_bytes,tunnel,attribution,route,session) VALUES('2024-01-01T00:00:00Z',5,'GET','http://x/','x','http',200,1,2,0,'a','r','s'); PRAGMA user_version=1`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = OpenStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var version, count int
	if err = s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRow(`SELECT count(*) FROM exchanges`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion || count != 1 {
		t.Fatalf("version=%d count=%d", version, count)
	}
}

func TestTaskSwitchClearsRunAndRuntimeCannotBeForged(t *testing.T) {
	s := NewState("runtime-1")
	if err := s.Set("task_ref", "task-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("run_ref", "run-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("task_ref", "task-2"); err != nil {
		t.Fatal(err)
	}
	if s.Get().RunRef != "" {
		t.Fatal("run_ref survived task switch")
	}
	if err := s.Set("runtime_ref", "runtime-2"); err == nil {
		t.Fatal("forged runtime_ref accepted")
	}
	if err := s.Clear("runtime_ref"); err == nil {
		t.Fatal("runtime_ref clear accepted")
	}
}

func TestExchangeCapRecordsCurrentEviction(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 2; i++ {
		now := time.Now()
		if err := s.Record(Audit{Started: now, Completed: now, Method: "GET", URL: "http://x", Host: "x", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", ReqState: "none", RespState: "none"}); err != nil {
			t.Fatal(err)
		}
	}
	var count, pressure, evicted int
	if err := s.db.QueryRow(`SELECT count(*),quota_pressure,evicted_exchanges FROM exchanges`).Scan(&count, &pressure, &evicted); err != nil {
		t.Fatal(err)
	}
	if count != 1 || pressure != 0 || evicted != 1 {
		t.Fatalf("count=%d pressure=%d evicted=%d", count, pressure, evicted)
	}
}

func TestRuntimeQuotaRecordsPressureAndEviction(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 2; i++ {
		now := time.Now()
		if err := s.Record(Audit{Started: now, Completed: now, Method: "GET", URL: "http://x", Host: "x", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", ReqState: "none", RespState: "none"}); err != nil {
			t.Fatal(err)
		}
	}
	var count, pressure, evicted int
	if err := s.db.QueryRow(`SELECT count(*),quota_pressure,evicted_exchanges FROM exchanges`).Scan(&count, &pressure, &evicted); err != nil {
		t.Fatal(err)
	}
	if count != 1 || pressure != 1 || evicted != 1 {
		t.Fatalf("count=%d pressure=%d evicted=%d", count, pressure, evicted)
	}
}
