package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCertificateAuthorityPersistsPerRuntimeAndPermissions(t *testing.T) {
	dir := t.TempDir()
	first, err := OpenCertificateAuthority(dir, "runtime-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := OpenCertificateAuthority(dir, "runtime-a")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.CertificatePEM(), second.CertificatePEM()) {
		t.Fatal("runtime CA changed across restart")
	}
	keyPath := filepath.Join(dir, "ca", "runtime-a", "ca.key")
	info, err := os.Stat(keyPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("CA key mode=%v err=%v", info.Mode().Perm(), err)
	}
	other, err := OpenCertificateAuthority(dir, "runtime-b")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first.CertificatePEM(), other.CertificatePEM()) {
		t.Fatal("different runtimes share a CA")
	}
	if err = os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenCertificateAuthority(dir, "runtime-a"); err == nil {
		t.Fatal("unsafe CA key permissions accepted")
	}
}

func TestLeafCertificateDNSIPAndCache(t *testing.T) {
	ca, err := OpenCertificateAuthority(t.TempDir(), "runtime")
	if err != nil {
		t.Fatal(err)
	}
	dns1, err := ca.Leaf("example.test")
	if err != nil {
		t.Fatal(err)
	}
	dns2, _ := ca.Leaf("EXAMPLE.TEST")
	if dns1 != dns2 {
		t.Fatal("DNS leaf was not cached")
	}
	dnsCert, _ := x509.ParseCertificate(dns1.Certificate[0])
	if err = dnsCert.VerifyHostname("example.test"); err != nil {
		t.Fatal(err)
	}
	ipLeaf, err := ca.Leaf("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	ipCert, _ := x509.ParseCertificate(ipLeaf.Certificate[0])
	if err = ipCert.VerifyHostname("127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if len(ipCert.IPAddresses) != 1 || len(ipCert.DNSNames) != 0 {
		t.Fatalf("unexpected IP SANs: %v %v", ipCert.IPAddresses, ipCert.DNSNames)
	}
}

func mitmClient(t *testing.T, p *Proxy, ca *CertificateAuthority) (*http.Client, func()) {
	t.Helper()
	proxyServer := httptest.NewServer(p)
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca.CertificatePEM()) {
		t.Fatal("failed to trust MITM CA")
	}
	proxyURL, _ := url.Parse(proxyServer.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots}}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	return client, func() {
		transport.CloseIdleConnections()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := p.Shutdown(ctx); err != nil {
			t.Errorf("proxy shutdown: %v", err)
		}
		proxyServer.Close()
	}
}

func TestConnectMITMHTTPSCaptureAndStrictUpstreamTLS(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		_, _ = w.Write([]byte("secure-body"))
	}))
	defer up.Close()
	ca, err := OpenCertificateAuthority(t.TempDir(), "runtime")
	if err != nil {
		t.Fatal(err)
	}
	upRoots := x509.NewCertPool()
	upRoots.AddCert(up.Certificate())
	s := testStore(t)
	p := &Proxy{Store: s, State: NewState("runtime"), CA: ca, ConnectMode: "mitm", CaptureLimit: 1024, HeaderLimit: 1024, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: upRoots}}}
	client, closeProxy := mitmClient(t, p, ca)
	defer closeProxy()
	resp, err := client.Get(up.URL + "/path")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "secure-body" {
		t.Fatalf("body=%q", body)
	}
	var mode, protocol, connectRef, bodyRef string
	if err = s.db.QueryRow(`SELECT mode,protocol,connect_ref,response_body_ref FROM exchanges WHERE mode='mitm'`).Scan(&mode, &protocol, &connectRef, &bodyRef); err != nil {
		t.Fatal(err)
	}
	if mode != "mitm" || protocol != "HTTP/1.1" || connectRef == "" || bodyRef == "" {
		t.Fatalf("bad MITM audit: %q %q %q %q", mode, protocol, connectRef, bodyRef)
	}

	untrusted := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer untrusted.Close()
	resp, err = client.Get(strings.Replace(untrusted.URL, "127.0.0.1", "localhost", 1))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("strict upstream TLS status=%d", resp.StatusCode)
	}
}

func TestHistoryFilterPaginationDetailAndBodyBounds(t *testing.T) {
	s := testStore(t)
	base := time.Now().UTC()
	for i := 0; i < 3; i++ {
		now := base.Add(time.Duration(i) * time.Millisecond)
		blob, err := s.PutBlob([]byte{0, 1, byte(i), 255})
		if err != nil {
			t.Fatal(err)
		}
		a := Audit{Started: now, Completed: now, Method: "GET", URL: "https://example.test/", Host: "example.test", Scheme: "https", Protocol: "HTTP/1.1", Mode: "mitm", Status: 200, RuntimeRef: "r", RouteRef: "route", SessionRef: "s", ReqState: "none", RespState: "captured", RespBlob: blob, RespCaptured: 4, ResponseHeaders: http.Header{"Set-Cookie": {"a=1", "b=2"}}}
		if i == 1 {
			a.Err = "upstream verification failed"
		}
		if err = s.Record(a); err != nil {
			t.Fatal(err)
		}
	}
	page1, err := s.HistoryList("", 2, HistoryFilter{SessionRef: "s", Mode: "mitm"})
	if err != nil {
		t.Fatal(err)
	}
	items := page1["items"].([]Exchange)
	if len(items) != 2 || page1["has_more"] != true || page1["next_cursor"] == "" {
		t.Fatalf("bad first page: %#v", page1)
	}
	page2, err := s.HistoryList(page1["next_cursor"].(string), 2, HistoryFilter{SessionRef: "s"})
	if err != nil || len(page2["items"].([]Exchange)) != 1 {
		t.Fatalf("bad second page: %#v %v", page2, err)
	}
	filtered, err := s.HistoryList("", 10, HistoryFilter{
		RouteRef:      "route",
		StartedAfter:  base.Add(500 * time.Microsecond).Format(time.RFC3339Nano),
		StartedBefore: base.Add(1500 * time.Microsecond).Format(time.RFC3339Nano),
		Error:         "upstream verification failed",
	})
	if err != nil || len(filtered["items"].([]Exchange)) != 1 {
		t.Fatalf("time/route/error filters failed: %#v %v", filtered, err)
	}
	detail, err := s.HistoryGet(items[0].ID)
	if err != nil || len(detail.ResponseHeaders) != 2 || detail.ResponseHeaders[0].Value == detail.ResponseHeaders[1].Value {
		t.Fatalf("duplicate headers lost: %#v %v", detail.ResponseHeaders, err)
	}
	body, err := s.HistoryBody(items[0].ID, "response", 2)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(body["data"].(string))
	if err != nil || len(decoded) != 2 || body["truncated"] != true {
		t.Fatalf("binary body response=%#v decoded=%v err=%v", body, decoded, err)
	}
	if _, err = s.HistoryList("bad!", 2, HistoryFilter{}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	if _, err = s.HistoryList("", maxHistoryPage+1, HistoryFilter{}); err == nil {
		t.Fatal("oversized page accepted")
	}
	if _, err = s.HistoryBody(items[0].ID, "response", maxBodyRead+1); err == nil {
		t.Fatal("oversized body read accepted")
	}
}

func TestPassthroughStoresMetadataOnly(t *testing.T) {
	now := time.Now()
	a := Audit{Started: now, Completed: now, Method: "CONNECT", URL: "example.test:443", Host: "example.test:443", Scheme: "connect", Protocol: "HTTP/1.1", Mode: "connect_passthrough", Status: 200, ReqState: "metadata_only", RespState: "metadata_only", ReqObserved: 99, RespObserved: 100}
	s := testStore(t)
	if err := s.Record(a); err != nil {
		t.Fatal(err)
	}
	x, err := s.HistoryGet(1)
	if err != nil {
		t.Fatal(err)
	}
	if x.RequestBodyRef != "" || x.ResponseBodyRef != "" || !strings.Contains(x.Mode, "passthrough") {
		t.Fatalf("passthrough captured body: %#v", x)
	}
}

func TestControlHistoryCommands(t *testing.T) {
	dir := t.TempDir()
	ln, err := listenControl(filepath.Join(dir, "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	s := testStore(t)
	now := time.Now()
	if err = s.Record(Audit{Started: now, Completed: now, Method: "GET", URL: "http://x/", Host: "x", Scheme: "http", Protocol: "HTTP/1.1", Mode: "forward", Status: 204, ReqState: "none", RespState: "none"}); err != nil {
		t.Fatal(err)
	}
	go serveControl(ln, NewState("runtime"), func() {}, s)
	conn, err := net.Dial("unix", filepath.Join(dir, "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	send := func(req controlRequest) controlResponse {
		data, _ := json.Marshal(req)
		if _, err := conn.Write(append(data, '\n')); err != nil {
			t.Fatal(err)
		}
		line, err := rd.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var resp controlResponse
		if err = json.Unmarshal(line, &resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}
	if resp := send(controlRequest{Version: 1, Command: "history_list", Limit: 1}); !resp.OK {
		t.Fatalf("history_list failed: %#v", resp)
	}
	if resp := send(controlRequest{Version: 1, Command: "history_get", ExchangeID: 1}); !resp.OK {
		t.Fatalf("history_get failed: %#v", resp)
	}
	if resp := send(controlRequest{Version: 1, Command: "history_body", ExchangeID: 1, Side: "response"}); resp.OK || resp.Error != "body not captured" {
		t.Fatalf("history_body error is not explicit: %#v", resp)
	}
}
