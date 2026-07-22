package main

import (
	"bufio"
	"context"
	"errors"
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

func TestConnectPassthroughPreservesHijackBufferedBytes(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		conn, acceptErr := echo.Accept()
		if acceptErr == nil {
			defer conn.Close()
			_, _ = io.Copy(conn, conn)
		}
	}()

	p := &Proxy{Store: testStore(t), State: NewState("runtime"), Dialer: net.Dialer{Timeout: time.Second}, ConnectMode: "passthrough"}
	server := httptest.NewServer(p)
	defer server.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	payload := "pipelined-after-connect"
	_, err = fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n%s", echo.Addr(), echo.Addr(), payload)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		if line == "\r\n" {
			break
		}
	}
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(reader, got); err != nil || string(got) != payload {
		t.Fatalf("buffered tunnel bytes=%q err=%v", got, err)
	}
	_ = conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = p.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestControlDoesNotUnlinkActiveSocket(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "traffic-proxy-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "control.sock")
	first, err := listenControl(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err = listenControl(path); err == nil || !strings.Contains(err.Error(), "already active") {
		t.Fatalf("active socket accepted: %v", err)
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("original socket was unlinked: %v", err)
	}
	_ = conn.Close()
}

func TestDataAndCAPathsRejectSymlinksAndUnsafeModes(t *testing.T) {
	parent := t.TempDir()
	real := filepath.Join(parent, "real")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(parent, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(link, 0); err == nil {
		t.Fatal("symlink data directory accepted")
	}

	unsafe := filepath.Join(parent, "unsafe")
	if err := os.Mkdir(unsafe, 0755); err != nil {
		t.Fatal(err)
	}
	ca, err := OpenCertificateAuthority(unsafe, "runtime")
	if err != nil || ca == nil {
		t.Fatalf("secure permission repair failed: %v", err)
	}
	info, err := os.Stat(unsafe)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("data directory mode=%v err=%v", info.Mode().Perm(), err)
	}

	data := filepath.Join(parent, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(data, "ca")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenCertificateAuthority(data, "runtime"); err == nil {
		t.Fatal("symlink CA directory accepted")
	}
}

func TestReplayRejectsForgedRuntimeRef(t *testing.T) {
	store := testStore(t)
	sourceID := replaySource(t, store, "http://example.test/", nil, nil)
	p := &Proxy{Store: store, State: NewState("active-runtime")}
	result, err := p.Replay(context.Background(), ReplayRequest{ExchangeID: sourceID, Context: &Context{RuntimeRef: "forged-runtime"}})
	if replayCode(err) != "invalid_context" || result.ExchangeID != 0 {
		t.Fatalf("forged replay result=%#v err=%v", result, err)
	}
}

func TestTruncatedCaptureStatesRemainConsistent(t *testing.T) {
	store := testStore(t)
	p := &Proxy{Store: store, State: NewState("runtime"), CaptureLimit: 0, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		_, _ = io.Copy(io.Discard, r.Body)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("response"))}, nil
	})}
	p.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://example.test/", strings.NewReader("request")))
	x, err := store.HistoryGet(1)
	if err != nil {
		t.Fatal(err)
	}
	if !x.RequestTruncated || x.RequestCaptureState != "truncated" || !x.ResponseTruncated || x.ResponseCaptureState != "truncated" {
		t.Fatalf("inconsistent capture states: %#v", x)
	}
}

func TestPassthroughShutdownClosesUpstreamConnection(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, acceptErr := upstream.Accept()
		if acceptErr == nil {
			accepted <- conn
		}
	}()
	p := &Proxy{Store: testStore(t), State: NewState("runtime"), Dialer: net.Dialer{Timeout: time.Second}, ConnectMode: "passthrough"}
	server := httptest.NewServer(p)
	defer server.Close()
	client, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, _ = fmt.Fprintf(client, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", upstream.Addr(), upstream.Addr())
	reader := bufio.NewReader(client)
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		if line == "\r\n" {
			break
		}
	}
	up := <-accepted
	defer up.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = p.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	_ = up.SetReadDeadline(time.Now().Add(time.Second))
	one := make([]byte, 1)
	if _, err = up.Read(one); !errors.Is(err, io.EOF) {
		t.Fatalf("upstream connection remained open: %v", err)
	}
}

func TestReplayRotationKeepsForeignKeyRelationship(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now()
	source := Audit{Started: now, Completed: now, Method: "GET", URL: "http://example.test/", Host: "example.test", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", ReqState: "none", RespState: "none"}
	sourceID, err := store.RecordWithID(source)
	if err != nil {
		t.Fatal(err)
	}
	replay := source
	replay.Mode = "replay"
	replay.ReplayOf = sourceID
	replayID, err := store.RecordWithID(replay)
	if err != nil {
		t.Fatal(err)
	}
	var count, pressure, fkViolations int
	if err = store.db.QueryRow(`SELECT count(*) FROM exchanges WHERE id IN (?,?)`, sourceID, replayID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err = store.db.QueryRow(`SELECT quota_pressure FROM exchanges WHERE id=?`, replayID).Scan(&pressure); err != nil {
		t.Fatal(err)
	}
	if err = store.db.QueryRow(`SELECT count(*) FROM pragma_foreign_key_check`).Scan(&fkViolations); err != nil {
		t.Fatal(err)
	}
	if count != 2 || pressure != 1 || fkViolations != 0 {
		t.Fatalf("count=%d pressure=%d fk_violations=%d", count, pressure, fkViolations)
	}
}
