package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Proxy struct {
	Store         *Store
	State         *State
	Transport     http.RoundTripper
	CaptureLimit  int64
	HeaderLimit   int64
	Dialer        net.Dialer
	Self          []string
	CA            *CertificateAuthority
	ConnectMode   string
	ReplayLimit   int
	ReplayTimeout time.Duration

	replayMu  sync.Mutex
	replaySem map[string]chan struct{}

	connectMu      sync.Mutex
	connectClosing bool
	connectConns   map[net.Conn]struct{}
	connectWG      sync.WaitGroup
}

type mitmContext struct {
	ref, authority, host, port string
}
type mitmContextKey struct{}

type bufferedConn struct {
	net.Conn
	reader io.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.State.Inc()
	if r.Method == http.MethodConnect {
		p.connect(w, r)
	} else {
		p.forward(w, r)
	}
}
func badText(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0
}
func (p *Proxy) validate(r *http.Request) error {
	if badText(r.Host) || badText(r.URL.String()) {
		return errors.New("control character in target")
	}
	if r.URL.Scheme != "http" && r.URL.Scheme != "https" {
		return errors.New("absolute http or https URL required")
	}
	if r.URL.Host == "" {
		return errors.New("target host required")
	}
	h := strings.ToLower(r.URL.Host)
	for _, self := range p.Self {
		if h == strings.ToLower(self) {
			return errors.New("proxy self-target denied")
		}
	}
	return nil
}

type captureReadCloser struct {
	body  io.ReadCloser
	limit int64
	mu    sync.Mutex
	read  int64
	data  []byte
}

func (c *captureReadCloser) Read(b []byte) (int, error) {
	n, err := c.body.Read(b)
	c.mu.Lock()
	c.read += int64(n)
	remaining := c.limit - int64(len(c.data))
	if remaining > 0 {
		take := int64(n)
		if take > remaining {
			take = remaining
		}
		c.data = append(c.data, b[:take]...)
	}
	c.mu.Unlock()
	return n, err
}
func (c *captureReadCloser) Close() error { return c.body.Close() }
func (c *captureReadCloser) snapshot() (int64, []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.read, append([]byte(nil), c.data...)
}
func (p *Proxy) newAudit(r *http.Request, mode string) Audit {
	a := Audit{Started: time.Now(), Method: r.Method, URL: r.URL.String(), Host: r.URL.Host, Scheme: r.URL.Scheme, Protocol: r.Proto, Mode: mode, ReqState: "none", RespState: "none"}
	c := p.State.Get()
	a.RuntimeRef = c.RuntimeRef
	a.TaskRef = c.TaskRef
	a.RunRef = c.RunRef
	a.Attribution = c.Attribution
	a.RouteRef = c.RouteRef
	a.SessionRef = c.SessionRef
	if mc, ok := r.Context().Value(mitmContextKey{}).(mitmContext); ok {
		a.Mode = "mitm"
		a.ConnectRef = mc.ref
		a.ConnectAuthority, a.ConnectHost, a.ConnectPort = mc.authority, mc.host, mc.port
	}
	a.RequestHeaders, a.HeaderTruncated, a.HeaderTruncationReason = limitedHeaders(r.Header, p.HeaderLimit)
	return a
}
func limitedHeaders(h http.Header, limit int64) (http.Header, bool, string) {
	out := make(http.Header)
	if limit <= 0 && len(h) > 0 {
		return out, true, "header_limit"
	}
	var used int64
	for name, values := range h {
		for _, value := range values {
			n := int64(len(name) + len(value))
			if used+n > limit {
				return out, true, "header_limit"
			}
			out[name] = append(out[name], value)
			used += n
		}
	}
	return out, false, ""
}
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request) {
	a := p.newAudit(r, "forward")
	var reqBody *captureReadCloser
	defer func() {
		if reqBody != nil {
			var data []byte
			a.ReqObserved, data = reqBody.snapshot()
			a.ReqCaptured = int64(len(data))
			if a.ReqObserved > a.ReqCaptured {
				a.ReqTruncated = true
				a.ReqTruncationReason = "body_limit"
			}
			if len(data) > 0 {
				var err error
				a.ReqBlob, err = p.Store.PutBlob(data)
				if err != nil {
					a.Err = joinError(a.Err, "request capture: "+err.Error())
					a.ReqState = "error"
				} else {
					a.ReqState = "captured"
				}
			}
			if a.ReqTruncated && a.ReqState != "error" {
				a.ReqState = "truncated"
			}
		}
		a.Completed = time.Now()
		if err := p.Store.Record(a); err != nil {
			log.Printf("audit storage error: %v", err)
		}
	}()
	if err := p.validate(r); err != nil {
		a.Err = err.Error()
		a.Status = 400
		http.Error(w, a.Err, 400)
		return
	}
	out := r.Clone(context.Background())
	if out.Body != nil {
		reqBody = &captureReadCloser{body: out.Body, limit: p.CaptureLimit}
		out.Body = reqBody
	}
	out.RequestURI = ""
	stripHop(out.Header)
	if out.Host == "" {
		out.Host = out.URL.Host
	}
	tr := p.Transport
	if tr == nil {
		tr = http.DefaultTransport
	}
	resp, err := tr.RoundTrip(out)
	if err != nil {
		a.Err = err.Error()
		a.Status = 502
		http.Error(w, "upstream error", 502)
		return
	}
	defer resp.Body.Close()
	a.Status = resp.StatusCode
	a.ResponseHeaders, _, _ = limitedHeaders(resp.Header, p.HeaderLimit)
	if _, trunc, _ := limitedHeaders(resp.Header, p.HeaderLimit); trunc {
		a.HeaderTruncated = true
		a.HeaderTruncationReason = "header_limit"
	}
	for k, v := range resp.Header {
		for _, x := range v {
			w.Header().Add(k, x)
		}
	}
	stripHop(w.Header())
	w.WriteHeader(resp.StatusCode)
	var captured bytes.Buffer
	n, copyErr := io.Copy(w, io.TeeReader(io.LimitReader(resp.Body, p.CaptureLimit), &captured))
	a.RespObserved = n
	if copyErr == nil {
		rest, e := io.Copy(w, resp.Body)
		a.RespObserved += rest
		copyErr = e
	}
	a.RespCaptured = int64(captured.Len())
	if a.RespObserved > a.RespCaptured {
		a.RespTruncated = true
		a.RespTruncationReason = "body_limit"
	}
	if copyErr != nil {
		a.Err = joinError(a.Err, copyErr.Error())
	}
	if captured.Len() > 0 {
		a.RespBlob, err = p.Store.PutBlob(captured.Bytes())
		if err != nil {
			a.Err = joinError(a.Err, "response capture: "+err.Error())
			a.RespState = "error"
		} else {
			a.RespState = "captured"
		}
	}
	if a.RespTruncated && a.RespState != "error" {
		a.RespState = "truncated"
	}
}
func joinError(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}
func stripHop(h http.Header) {
	for _, name := range h.Values("Connection") {
		for _, token := range strings.Split(name, ",") {
			h.Del(strings.TrimSpace(token))
		}
	}
	for _, k := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(k)
	}
}

func (p *Proxy) beginConnect() bool {
	p.connectMu.Lock()
	defer p.connectMu.Unlock()
	if p.connectClosing {
		return false
	}
	p.connectWG.Add(1)
	return true
}

func (p *Proxy) trackConnect(conn net.Conn) bool {
	p.connectMu.Lock()
	defer p.connectMu.Unlock()
	if p.connectClosing {
		return false
	}
	if p.connectConns == nil {
		p.connectConns = make(map[net.Conn]struct{})
	}
	p.connectConns[conn] = struct{}{}
	return true
}

func (p *Proxy) untrackConnect(conn net.Conn) {
	p.connectMu.Lock()
	delete(p.connectConns, conn)
	p.connectMu.Unlock()
}

func (p *Proxy) endConnect(conn net.Conn) {
	if conn != nil {
		p.untrackConnect(conn)
	}
	p.connectWG.Done()
}

func (p *Proxy) Shutdown(ctx context.Context) error {
	p.connectMu.Lock()
	p.connectClosing = true
	connections := make([]net.Conn, 0, len(p.connectConns))
	for conn := range p.connectConns {
		connections = append(connections, conn)
	}
	p.connectMu.Unlock()
	for _, conn := range connections {
		_ = conn.Close()
	}

	done := make(chan struct{})
	go func() {
		p.connectWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	if !p.beginConnect() {
		http.Error(w, "proxy is shutting down", http.StatusServiceUnavailable)
		return
	}
	var client net.Conn
	defer func() { p.endConnect(client) }()

	mode := p.ConnectMode
	if mode == "" {
		mode = "mitm"
	}
	a := p.newAudit(r, "connect_"+mode)
	a.URL, a.Host, a.Scheme = r.Host, r.Host, "connect"
	a.ConnectAuthority = r.Host
	a.ReqState, a.RespState = "metadata_only", "metadata_only"
	refBytes := make([]byte, 16)
	_, _ = rand.Read(refBytes)
	a.ConnectRef = hex.EncodeToString(refBytes)
	defer func() {
		a.Completed = time.Now()
		if err := p.Store.Record(a); err != nil {
			log.Printf("audit storage error: %v", err)
		}
	}()
	host, port, err := p.validateConnectTarget(r.Host)
	if err != nil {
		a.Status, a.Err = http.StatusForbidden, err.Error()
		http.Error(w, a.Err, a.Status)
		return
	}
	a.ConnectHost, a.ConnectPort = host, port
	if mode != "mitm" && mode != "passthrough" {
		a.Status, a.Err = http.StatusInternalServerError, "invalid CONNECT mode"
		http.Error(w, a.Err, a.Status)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		a.Status, a.Err = 500, "hijacking unsupported"
		http.Error(w, a.Err, 500)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		a.Status, a.Err = 500, err.Error()
		return
	}
	defer client.Close()
	if !p.trackConnect(client) {
		a.Status, a.Err = http.StatusServiceUnavailable, "proxy is shutting down"
		return
	}
	if mode == "passthrough" {
		p.passthrough(client, buf, r.Host, &a)
		return
	}
	p.mitm(client, buf, host, port, &a)
}

func (p *Proxy) validateConnectTarget(authority string) (string, string, error) {
	if authority == "" || badText(authority) {
		return "", "", errors.New("invalid CONNECT target")
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil || host == "" || port == "" {
		return "", "", errors.New("CONNECT target must be host:port")
	}
	for _, self := range p.Self {
		if strings.EqualFold(authority, self) {
			return "", "", errors.New("proxy self-target denied")
		}
	}
	return host, port, nil
}

func (p *Proxy) passthrough(client net.Conn, buf *bufio.ReadWriter, authority string, a *Audit) {
	up, err := p.Dialer.Dial("tcp", authority)
	if err != nil {
		a.Status, a.Err = 502, err.Error()
		_, _ = buf.WriteString("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
		_ = buf.Flush()
		return
	}
	defer up.Close()
	if !p.trackConnect(up) {
		a.Status, a.Err = http.StatusServiceUnavailable, "proxy is shutting down"
		return
	}
	defer p.untrackConnect(up)
	if _, err = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err == nil {
		err = buf.Flush()
	}
	if err != nil {
		a.Err = err.Error()
		return
	}
	a.Status = 200
	clientReader := &bufferedConn{Conn: client, reader: buf.Reader}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		a.ReqObserved, _ = io.Copy(up, clientReader)
		if tcp, ok := up.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		a.RespObserved, _ = io.Copy(client, up)
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	wg.Wait()
}

func (p *Proxy) mitm(client net.Conn, buf *bufio.ReadWriter, host, port string, a *Audit) {
	if p.CA == nil {
		a.Status, a.Err = 500, "MITM certificate authority unavailable"
		_, _ = buf.WriteString("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
		_ = buf.Flush()
		return
	}
	leaf, err := p.CA.Leaf(host)
	if err != nil {
		a.Status, a.Err = 500, "leaf certificate: "+err.Error()
		return
	}
	if _, err = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err == nil {
		err = buf.Flush()
	}
	if err != nil {
		a.Err = err.Error()
		return
	}
	tlsClient := tls.Server(&bufferedConn{Conn: client, reader: buf.Reader}, &tls.Config{Certificates: []tls.Certificate{*leaf}, MinVersion: tls.VersionTLS12})
	if err = tlsClient.Handshake(); err != nil {
		a.Status, a.Err = 502, "client TLS handshake: "+err.Error()
		return
	}
	a.Status = 200
	rd := bufio.NewReader(tlsClient)
	wr := bufio.NewWriter(tlsClient)
	for {
		req, readErr := http.ReadRequest(rd)
		if readErr != nil {
			if readErr != io.EOF {
				a.Err = joinError(a.Err, "MITM request: "+readErr.Error())
			}
			return
		}
		req.URL.Scheme = "https"
		req.URL.Host = net.JoinHostPort(host, port)
		req.Host = req.URL.Host
		req.RequestURI = req.URL.RequestURI()
		req = req.WithContext(context.WithValue(req.Context(), mitmContextKey{}, mitmContext{ref: a.ConnectRef, authority: a.ConnectAuthority, host: host, port: port}))
		rw := &connResponseWriter{writer: wr, request: req, header: make(http.Header)}
		p.forward(rw, req)
		if err = rw.finish(); err != nil {
			a.Err = joinError(a.Err, err.Error())
			return
		}
		if req.Close || rw.close {
			return
		}
	}
}

type connResponseWriter struct {
	writer  *bufio.Writer
	request *http.Request
	header  http.Header
	status  int
	wrote   bool
	close   bool
}

func (w *connResponseWriter) Header() http.Header { return w.header }
func (w *connResponseWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.wrote, w.status = true, status
	if w.header.Get("Content-Length") == "" {
		w.close = true
		w.header.Set("Connection", "close")
	}
	_, _ = fmt.Fprintf(w.writer, "HTTP/1.1 %d %s\r\n", status, http.StatusText(status))
	_ = w.header.Write(w.writer)
	_, _ = w.writer.WriteString("\r\n")
}
func (w *connResponseWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.writer.Write(b)
}
func (w *connResponseWriter) finish() error {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.writer.Flush()
}
func normalizeListen(addr string) ([]string, error) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("listen address: %w", err)
	}
	return []string{addr, "localhost:" + port, "127.0.0.1:" + port, "[::1]:" + port}, nil
}
func targetURL(raw string) (*url.URL, error) { return url.Parse(raw) }
