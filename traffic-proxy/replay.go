package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxReplayMethodBytes = 32
	maxReplayURLBytes    = 8 << 10
	maxReplayHeaderBytes = 64 << 10
	maxReplayBodyBytes   = 1 << 20
	maxReplayResponse    = 1 << 20
	defaultReplayLimit   = 4
	defaultReplayTimeout = 30 * time.Second
)

type ReplayBody struct {
	Encoding string `json:"encoding"`
	Data     string `json:"data"`
}

type ReplayRequest struct {
	ExchangeID int64          `json:"exchange_id"`
	Method     string         `json:"method,omitempty"`
	URL        string         `json:"url,omitempty"`
	Headers    *[]HeaderEntry `json:"headers,omitempty"`
	Body       *ReplayBody    `json:"body,omitempty"`
	RouteRef   string         `json:"route_ref,omitempty"`
	SessionRef string         `json:"session_ref,omitempty"`
	Context    *Context       `json:"context"`
}

type ReplayResult struct {
	ExchangeID int64  `json:"exchange_id"`
	ReplayOf   int64  `json:"replay_of"`
	Status     int    `json:"status"`
	ErrorCode  string `json:"error_code,omitempty"`
}

type ReplayError struct {
	Code string
	Err  error
}

func (e *ReplayError) Error() string { return e.Err.Error() }
func replayError(code, message string) *ReplayError {
	return &ReplayError{Code: code, Err: errors.New(message)}
}

func (p *Proxy) Replay(parent context.Context, in ReplayRequest) (ReplayResult, error) {
	if in.Context == nil || in.Context.RuntimeRef == "" {
		return ReplayResult{}, replayError("invalid_context", "replay context with runtime_ref is required")
	}
	ctxValue := *in.Context
	if p.State == nil || ctxValue.RuntimeRef != p.State.Get().RuntimeRef {
		return ReplayResult{}, replayError("invalid_context", "replay runtime_ref must match the active runtime")
	}
	if in.RouteRef != "" {
		ctxValue.RouteRef = in.RouteRef
	}
	if in.SessionRef != "" {
		ctxValue.SessionRef = in.SessionRef
	}
	for _, value := range []string{ctxValue.RuntimeRef, ctxValue.TaskRef, ctxValue.RunRef, ctxValue.Attribution, ctxValue.RouteRef, ctxValue.SessionRef} {
		if badText(value) {
			return ReplayResult{}, replayError("invalid_context", "replay context contains control characters")
		}
	}
	source, err := p.Store.HistoryGet(in.ExchangeID)
	if err != nil {
		return ReplayResult{}, replayError("source_not_found", err.Error())
	}

	a := Audit{Started: time.Now(), Method: source.Method, URL: source.URL, Host: source.Host, Scheme: source.Scheme, Protocol: "HTTP/1.1", Mode: "replay", ReqState: "none", RespState: "none", ReplayOf: source.ID}
	a.RuntimeRef, a.TaskRef, a.RunRef = ctxValue.RuntimeRef, ctxValue.TaskRef, ctxValue.RunRef
	a.Attribution, a.RouteRef, a.SessionRef = ctxValue.Attribution, ctxValue.RouteRef, ctxValue.SessionRef

	method, target := source.Method, source.URL
	if in.Method != "" {
		method = in.Method
	}
	if in.URL != "" {
		target = in.URL
	}
	a.Method, a.URL = method, target
	headers := headersFromEntries(source.RequestHeaders)
	if in.Headers != nil {
		headers = headersFromEntries(*in.Headers)
	} else {
		headers = sanitizeCapturedReplayHeaders(headers)
	}
	body, prepareErr := p.prepareReplay(source, in, method, target, headers)
	if prepareErr != nil {
		return p.recordReplayFailure(a, prepareErr)
	}
	parsed, _ := url.Parse(target)
	a.Host, a.Scheme = parsed.Host, parsed.Scheme
	a.RequestHeaders = headers.Clone()
	a.ReqObserved, a.ReqCaptured = int64(len(body)), int64(len(body))
	if len(body) > 0 {
		a.ReqBlob, err = p.Store.PutBlob(body)
		if err != nil {
			return p.recordReplayFailure(a, replayError("storage_error", "store replay request body: "+err.Error()))
		}
		a.ReqState = "captured"
	}

	if !p.acquireReplay(ctxValue.RuntimeRef) {
		return p.recordReplayFailure(a, replayError("replay_busy", "runtime replay concurrency limit reached"))
	}
	defer p.releaseReplay(ctxValue.RuntimeRef)
	timeout := p.ReplayTimeout
	if timeout <= 0 {
		timeout = defaultReplayTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return p.recordReplayFailure(a, replayError("invalid_request", err.Error()))
	}
	req.Header = headers.Clone()
	if host := req.Header.Get("Host"); host != "" {
		req.Host = host
		req.Header.Del("Host")
	}
	transport := p.replayTransport()
	resp, err := transport.RoundTrip(req)
	if err != nil {
		return p.recordReplayFailure(a, classifyReplayTransportError(ctx, err))
	}
	defer resp.Body.Close()
	a.Status = resp.StatusCode
	a.ResponseHeaders, a.HeaderTruncated, a.HeaderTruncationReason = limitedHeaders(resp.Header, p.replayHeaderLimit())
	response, truncated, readErr := readLimited(resp.Body, p.replayCaptureLimit())
	a.RespObserved, a.RespCaptured = int64(len(response)), int64(len(response))
	if truncated {
		a.RespObserved++
		a.RespTruncated, a.RespTruncationReason = true, "body_limit"
	}
	if len(response) > 0 {
		a.RespBlob, err = p.Store.PutBlob(response)
		if err != nil {
			return p.recordReplayFailure(a, replayError("storage_error", "store replay response body: "+err.Error()))
		}
		a.RespState = "captured"
	}
	if truncated {
		a.RespState = "truncated"
	}
	if readErr != nil {
		return p.recordReplayFailure(a, replayError("response_read_error", readErr.Error()))
	}
	a.Completed = time.Now()
	id, err := p.Store.RecordWithID(a)
	if err != nil {
		return ReplayResult{}, replayError("storage_error", err.Error())
	}
	return ReplayResult{ExchangeID: id, ReplayOf: source.ID, Status: a.Status}, nil
}

func (p *Proxy) prepareReplay(source Exchange, in ReplayRequest, method, target string, headers http.Header) ([]byte, *ReplayError) {
	if source.Method == http.MethodConnect || strings.HasPrefix(source.Mode, "connect_") || source.RequestCaptureState == "metadata_only" || strings.Contains(source.Mode, "passthrough") {
		return nil, replayError("source_not_replayable", "metadata-only or CONNECT exchange cannot be replayed")
	}
	if source.RequestTruncated || source.HeadersTruncated {
		return nil, replayError("source_not_replayable", "truncated source request cannot be replayed")
	}
	if len(method) == 0 || len(method) > maxReplayMethodBytes || !validHTTPToken(method) || method == http.MethodConnect {
		return nil, replayError("invalid_method", "invalid replay method")
	}
	if len(target) == 0 || len(target) > maxReplayURLBytes || badText(target) {
		return nil, replayError("invalid_url", "invalid replay URL")
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return nil, replayError("invalid_url", "absolute http or https replay URL without userinfo is required")
	}
	probe := &http.Request{Method: method, URL: parsed, Host: parsed.Host}
	if err = p.validate(probe); err != nil {
		if strings.Contains(err.Error(), "self-target") {
			return nil, replayError("self_loop", err.Error())
		}
		return nil, replayError("invalid_url", err.Error())
	}
	if err = validateReplayHeaders(headers, parsed.Host); err != nil {
		return nil, err.(*ReplayError)
	}
	if in.Body != nil {
		if in.Body.Encoding != "base64" {
			return nil, replayError("invalid_body", "replay body encoding must be base64")
		}
		body, decodeErr := base64.StdEncoding.DecodeString(in.Body.Data)
		if decodeErr != nil {
			return nil, replayError("invalid_body", "invalid base64 replay body")
		}
		if len(body) > maxReplayBodyBytes {
			return nil, replayError("body_too_large", "replay body exceeds 1048576 bytes")
		}
		return body, nil
	}
	if source.RequestObservedBytes == 0 {
		return nil, nil
	}
	if source.RequestBodyRef == "" || source.RequestCaptureState != "captured" || source.RequestCapturedBytes != source.RequestObservedBytes {
		return nil, replayError("source_not_replayable", "source request body is missing or incomplete")
	}
	body, err := p.Store.ReadBlob(source.RequestBodyRef, maxReplayBodyBytes)
	if err != nil {
		return nil, replayError("source_not_replayable", "source request body unavailable: "+err.Error())
	}
	return body, nil
}

func sanitizeCapturedReplayHeaders(headers http.Header) http.Header {
	sanitized := headers.Clone()
	connectionTokens := make(map[string]bool)
	for _, value := range sanitized.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if token = strings.TrimSpace(token); token != "" {
				connectionTokens[strings.ToLower(token)] = true
			}
		}
	}
	for name := range sanitized {
		if isHopByHopHeader(http.CanonicalHeaderKey(name)) || connectionTokens[strings.ToLower(name)] {
			sanitized.Del(name)
		}
	}
	return sanitized
}

func validateReplayHeaders(headers http.Header, targetHost string) error {
	var used int
	connectionTokens := make(map[string]bool)
	for _, value := range headers.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			connectionTokens[strings.ToLower(strings.TrimSpace(token))] = true
		}
	}
	for name, values := range headers {
		canonical := http.CanonicalHeaderKey(name)
		lower := strings.ToLower(name)
		if !validHTTPToken(name) {
			return replayError("invalid_header", "invalid replay header name")
		}
		if isHopByHopHeader(canonical) || connectionTokens[lower] {
			return replayError("forbidden_header", "hop-by-hop replay header denied: "+name)
		}
		if strings.EqualFold(name, "Proxy-Authorization") {
			return replayError("forbidden_header", "Proxy-Authorization replay header denied")
		}
		for _, value := range values {
			if badText(value) {
				return replayError("invalid_header", "replay header contains control characters")
			}
			used += len(name) + len(value)
			if used > maxReplayHeaderBytes {
				return replayError("headers_too_large", "replay headers exceed 65536 bytes")
			}
			if strings.EqualFold(name, "Host") && !strings.EqualFold(value, targetHost) {
				return replayError("host_conflict", "Host replay header conflicts with target URL")
			}
		}
	}
	return nil
}

func headersFromEntries(entries []HeaderEntry) http.Header {
	h := make(http.Header)
	for _, entry := range entries {
		name := http.CanonicalHeaderKey(entry.Name)
		h[name] = append(h[name], entry.Value)
	}
	return h
}

func validHTTPToken(value string) bool {
	if value == "" {
		return false
	}
	const separators = "()<>@,;:\\\"/[]?={} \t"
	for i := 0; i < len(value); i++ {
		if value[i] <= 0x20 || value[i] >= 0x7f || strings.ContainsRune(separators, rune(value[i])) {
			return false
		}
	}
	return true
}

func isHopByHopHeader(name string) bool {
	switch name {
	case "Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	default:
		return false
	}
}

func (p *Proxy) acquireReplay(runtimeRef string) bool {
	p.replayMu.Lock()
	if p.replaySem == nil {
		p.replaySem = make(map[string]chan struct{})
	}
	sem := p.replaySem[runtimeRef]
	if sem == nil {
		limit := p.ReplayLimit
		if limit <= 0 {
			limit = defaultReplayLimit
		}
		sem = make(chan struct{}, limit)
		p.replaySem[runtimeRef] = sem
	}
	p.replayMu.Unlock()
	select {
	case sem <- struct{}{}:
		return true
	default:
		return false
	}
}

func (p *Proxy) releaseReplay(runtimeRef string) {
	p.replayMu.Lock()
	sem := p.replaySem[runtimeRef]
	p.replayMu.Unlock()
	<-sem
}

func (p *Proxy) replayTransport() http.RoundTripper {
	if configured, ok := p.Transport.(*http.Transport); ok {
		transport := configured.Clone()
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		} else {
			transport.TLSClientConfig = transport.TLSClientConfig.Clone()
			transport.TLSClientConfig.InsecureSkipVerify = false
			if transport.TLSClientConfig.MinVersion < tls.VersionTLS12 {
				transport.TLSClientConfig.MinVersion = tls.VersionTLS12
			}
		}
		return transport
	}
	if p.Transport != nil {
		return p.Transport
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return transport
}

func (p *Proxy) replayCaptureLimit() int64 {
	limit := p.CaptureLimit
	if limit <= 0 || limit > maxReplayResponse {
		return maxReplayResponse
	}
	return limit
}

func (p *Proxy) replayHeaderLimit() int64 {
	limit := p.HeaderLimit
	if limit <= 0 || limit > maxReplayHeaderBytes {
		return maxReplayHeaderBytes
	}
	return limit
}

func classifyReplayTransportError(ctx context.Context, err error) *ReplayError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return replayError("timeout", "replay request timed out")
	}
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return replayError("cancelled", "replay request cancelled")
	}
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalidCertificate x509.CertificateInvalidError
	var tlsHeader tls.RecordHeaderError
	if errors.As(err, &unknownAuthority) || errors.As(err, &hostname) || errors.As(err, &invalidCertificate) || errors.As(err, &tlsHeader) {
		return replayError("tls_error", "replay TLS verification failed")
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return replayError("timeout", "replay request timed out")
	}
	return replayError("upstream_error", "replay upstream request failed: "+err.Error())
}

func (p *Proxy) recordReplayFailure(a Audit, replayErr *ReplayError) (ReplayResult, error) {
	a.Completed, a.Err, a.ErrorCode = time.Now(), replayErr.Error(), replayErr.Code
	id, err := p.Store.RecordWithID(a)
	if err != nil {
		return ReplayResult{}, replayError("storage_error", fmt.Sprintf("record replay failure: %v", err))
	}
	return ReplayResult{ExchangeID: id, ReplayOf: a.ReplayOf, Status: a.Status, ErrorCode: replayErr.Code}, replayErr
}
