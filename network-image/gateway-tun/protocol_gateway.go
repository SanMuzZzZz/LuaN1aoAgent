package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/adapters/gonet"
	"github.com/nicocha30/gvisor-ligolo/pkg/tcpip/transport/tcp"
	"github.com/nicocha30/gvisor-ligolo/pkg/waiter"
	"golang.org/x/net/http2"
)

const protocolCaptureLimit = 1 << 20

type replayContext struct {
	ReplayOf      string `json:"replayOf"`
	RuntimeRef    string `json:"runtimeRef"`
	TaskRef       string `json:"taskRef"`
	RunRef        string `json:"runRef"`
	RouteRef      string `json:"routeRef"`
	ConnectionRef string `json:"connectionRef"`
	Attribution   string `json:"attribution"`
}

type protocolGateway struct {
	dialer            *routeDialer
	authority         *certificateAuthority
	capture           *captureWriter
	runRef            string
	taskRef           string
	bodyLimit         int
	replayContextPath string
	debug             bool
	sequence          atomic.Uint64
}

type dialedUpstream struct {
	connection    net.Conn
	routeRef      string
	connectionRef string
	replay        replayContext
}

type prefixedConn struct {
	net.Conn
	prefix *bytes.Reader
}

func (connection *prefixedConn) Read(payload []byte) (int, error) {
	if connection.prefix != nil && connection.prefix.Len() > 0 {
		return connection.prefix.Read(payload)
	}
	return connection.Conn.Read(payload)
}

func (connection *prefixedConn) CloseWrite() error {
	if halfCloser, ok := connection.Conn.(interface{ CloseWrite() error }); ok {
		return halfCloser.CloseWrite()
	}
	return fmt.Errorf("connection does not support half-close")
}

type firstRead struct {
	client bool
	data   []byte
	err    error
}

func (gateway *protocolGateway) handleTCP(ctx context.Context, request *tcp.ForwarderRequest) {
	endpointID := request.ID()
	destination := net.JoinHostPort(endpointID.LocalAddress.String(), fmt.Sprint(endpointID.LocalPort))
	upstream, err := gateway.dial(ctx, destination)
	if err != nil {
		reset := shouldResetTCP(err)
		// Dial failures are always logged: the success path is silent by
		// design, so without this line an infra outage (dead broker, stale
		// connector, firewall drop) looks exactly like a filtered target and
		// poisons the executor's model of the network.
		log.Printf("gateway dial %s failed (reset=%v): %v", destination, reset, err)
		request.Complete(reset)
		return
	}
	if gateway.replayContextPath != "" {
		upstream.replay = claimReplayContext(gateway.replayContextPath)
	}
	var waitQueue waiter.Queue
	endpoint, stackError := request.CreateEndpoint(&waitQueue)
	if stackError != nil {
		log.Printf("gateway handshake %s failed: %v", destination, stackError)
		upstream.connection.Close()
		request.Complete(true)
		return
	}
	request.Complete(false)
	client := gonet.NewTCPConn(&waitQueue, endpoint)
	tcpLease := gateway.beginTCPCapture()
	defer func() {
		if err := tcpLease.finish(); err != nil {
			log.Printf("finish TCP capture: %v", err)
		}
	}()
	if err := gateway.serve(ctx, client, upstream, destination); err != nil && ctx.Err() == nil {
		log.Printf("gateway session %s failed: %v", destination, err)
	}
}

func (gateway *protocolGateway) beginTCPCapture() *tcpCaptureLease {
	if gateway.capture == nil {
		return &tcpCaptureLease{}
	}
	lease, err := gateway.capture.beginTCP()
	if err != nil {
		log.Printf("begin TCP capture: %v", err)
		return &tcpCaptureLease{}
	}
	return lease
}

func (gateway *protocolGateway) dial(ctx context.Context, destination string) (*dialedUpstream, error) {
	connection, route, err := gateway.dialer.dialWithRoute(ctx, destination)
	if err != nil {
		return nil, err
	}
	result := &dialedUpstream{connection: connection}
	if route != nil {
		result.routeRef = route.RouteRef
		result.connectionRef = route.ConnectionRef
	}
	return result, nil
}

func (gateway *protocolGateway) serve(ctx context.Context, client net.Conn, upstream *dialedUpstream, destination string) error {
	defer client.Close()
	defer upstream.connection.Close()
	clientData, serverData := firstPayloads(client, upstream.connection)
	clientConn := &prefixedConn{Conn: client, prefix: bytes.NewReader(clientData)}
	serverConn := &prefixedConn{Conn: upstream.connection, prefix: bytes.NewReader(serverData)}
	if looksLikeTLS(clientData) && clientHelloOffersHTTP(clientData) {
		return gateway.serveTLS(ctx, clientConn, serverConn, upstream, destination)
	}
	if looksLikeHTTP(clientData) {
		return gateway.serveHTTP1(clientConn, serverConn, upstream, destination, "http")
	}
	if bytes.HasPrefix(clientData, []byte(http2.ClientPreface)) {
		return gateway.serveHTTP2(clientConn, serverConn, upstream, destination, "http", false)
	}
	relay(clientConn, serverConn)
	return nil
}

func firstPayloads(client, upstream net.Conn) ([]byte, []byte) {
	results := make(chan firstRead, 2)
	deadline := time.Now().Add(5 * time.Second)
	_ = client.SetReadDeadline(deadline)
	_ = upstream.SetReadDeadline(deadline)
	read := func(connection net.Conn, fromClient bool) {
		buffer := make([]byte, 32<<10)
		count, err := connection.Read(buffer)
		results <- firstRead{client: fromClient, data: buffer[:count], err: err}
	}
	go read(client, true)
	go read(upstream, false)
	first := <-results
	if first.client {
		_ = upstream.SetReadDeadline(time.Now())
	} else {
		_ = client.SetReadDeadline(time.Now())
	}
	second := <-results
	_ = client.SetReadDeadline(time.Time{})
	_ = upstream.SetReadDeadline(time.Time{})
	var clientData, serverData []byte
	for _, result := range []firstRead{first, second} {
		if len(result.data) == 0 {
			continue
		}
		if result.client {
			clientData = result.data
		} else {
			serverData = result.data
		}
	}
	return clientData, serverData
}

func looksLikeTLS(payload []byte) bool {
	return len(payload) >= 3 && payload[0] == 0x16 && payload[1] == 0x03
}

func clientHelloOffersHTTP(payload []byte) bool {
	if len(payload) < 9 || payload[0] != 0x16 || payload[5] != 0x01 {
		return false
	}
	recordLength := int(payload[3])<<8 | int(payload[4])
	if recordLength+5 > len(payload) {
		return false
	}
	handshakeLength := int(payload[6])<<16 | int(payload[7])<<8 | int(payload[8])
	if handshakeLength+9 > len(payload) {
		return false
	}
	cursor := 9 + 2 + 32
	if cursor >= len(payload) {
		return false
	}
	sessionLength := int(payload[cursor])
	cursor += 1 + sessionLength
	if cursor+2 > len(payload) {
		return false
	}
	cipherLength := int(payload[cursor])<<8 | int(payload[cursor+1])
	cursor += 2 + cipherLength
	if cursor >= len(payload) {
		return false
	}
	compressionLength := int(payload[cursor])
	cursor += 1 + compressionLength
	if cursor+2 > len(payload) {
		return false
	}
	extensionsLength := int(payload[cursor])<<8 | int(payload[cursor+1])
	cursor += 2
	extensionsEnd := cursor + extensionsLength
	if extensionsEnd > len(payload) {
		return false
	}
	for cursor+4 <= extensionsEnd {
		extensionType := int(payload[cursor])<<8 | int(payload[cursor+1])
		extensionLength := int(payload[cursor+2])<<8 | int(payload[cursor+3])
		cursor += 4
		if cursor+extensionLength > extensionsEnd {
			return false
		}
		if extensionType == 16 && alpnOffersHTTP(payload[cursor:cursor+extensionLength]) {
			return true
		}
		cursor += extensionLength
	}
	return false
}

func alpnOffersHTTP(extension []byte) bool {
	if len(extension) < 2 {
		return false
	}
	length := int(extension[0])<<8 | int(extension[1])
	if length+2 != len(extension) {
		return false
	}
	for cursor := 2; cursor < len(extension); {
		protocolLength := int(extension[cursor])
		cursor++
		if protocolLength == 0 || cursor+protocolLength > len(extension) {
			return false
		}
		protocol := string(extension[cursor : cursor+protocolLength])
		if protocol == "h2" || protocol == "http/1.1" {
			return true
		}
		cursor += protocolLength
	}
	return false
}

func looksLikeHTTP(payload []byte) bool {
	for _, method := range []string{"GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "OPTIONS ", "PATCH ", "TRACE ", "CONNECT "} {
		if bytes.HasPrefix(payload, []byte(method)) {
			return true
		}
	}
	return false
}

func (gateway *protocolGateway) serveTLS(
	ctx context.Context,
	client net.Conn,
	upstream net.Conn,
	route *dialedUpstream,
	destination string,
) error {
	var serverTLS *tls.Conn
	var setupErr error
	var setupOnce sync.Once
	clientTLS := tls.Server(client, &tls.Config{
		MinVersion: tls.VersionTLS10,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			setupOnce.Do(func() {
				host, _, _ := net.SplitHostPort(destination)
				serverName := hello.ServerName
				if serverName == "" {
					serverName = host
				}
				serverTLS = tls.Client(upstream, &tls.Config{
					InsecureSkipVerify: true,
					ServerName:         serverName,
					NextProtos:         hello.SupportedProtos,
					MinVersion:         tls.VersionTLS10,
				})
				setupErr = serverTLS.HandshakeContext(ctx)
			})
			if setupErr != nil {
				return nil, setupErr
			}
			host := hello.ServerName
			if host == "" {
				host, _, _ = net.SplitHostPort(destination)
			}
			certificate, err := gateway.authority.certificateFor(host)
			if err != nil {
				return nil, err
			}
			configuration := &tls.Config{Certificates: []tls.Certificate{*certificate}, MinVersion: tls.VersionTLS10}
			if negotiated := serverTLS.ConnectionState().NegotiatedProtocol; negotiated != "" {
				configuration.NextProtos = []string{negotiated}
			}
			return configuration, nil
		},
	})
	if err := clientTLS.HandshakeContext(ctx); err != nil {
		return err
	}
	if setupErr != nil || serverTLS == nil {
		return setupErr
	}
	negotiated := clientTLS.ConnectionState().NegotiatedProtocol
	if negotiated == "h2" {
		return gateway.serveHTTP2(clientTLS, serverTLS, route, destination, "https", true)
	}
	reader := bufio.NewReader(clientTLS)
	prefix, _ := reader.Peek(24)
	clientConn := &bufferedConn{Conn: clientTLS, reader: reader}
	if looksLikeHTTP(prefix) {
		return gateway.serveHTTP1(clientConn, serverTLS, route, destination, "https")
	}
	relay(clientConn, serverTLS)
	return nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (connection *bufferedConn) Read(payload []byte) (int, error) {
	return connection.reader.Read(payload)
}

func (connection *bufferedConn) CloseWrite() error {
	if halfCloser, ok := connection.Conn.(interface{ CloseWrite() error }); ok {
		return halfCloser.CloseWrite()
	}
	return fmt.Errorf("connection does not support half-close")
}

type limitedCapture struct {
	payload  bytes.Buffer
	observed int64
	limit    int
}

func (capture *limitedCapture) write(payload []byte) {
	capture.observed += int64(len(payload))
	remaining := capture.limit - capture.payload.Len()
	if remaining > len(payload) {
		remaining = len(payload)
	}
	if remaining > 0 {
		_, _ = capture.payload.Write(payload[:remaining])
	}
}

type capturingReadCloser struct {
	io.ReadCloser
	capture *limitedCapture
}

func (reader *capturingReadCloser) Read(payload []byte) (int, error) {
	count, err := reader.ReadCloser.Read(payload)
	reader.capture.write(payload[:count])
	return count, err
}

const passiveHTTPQueueDepth = 32

type passiveByteStream struct {
	chunks  chan []byte
	reader  *io.PipeReader
	done    chan struct{}
	dropped atomic.Bool
	once    sync.Once
}

func newPassiveByteStream() *passiveByteStream {
	reader, writer := io.Pipe()
	stream := &passiveByteStream{chunks: make(chan []byte, passiveHTTPQueueDepth), reader: reader, done: make(chan struct{})}
	go func() {
		defer close(stream.done)
		defer writer.Close()
		for chunk := range stream.chunks {
			if _, err := writer.Write(chunk); err != nil {
				for range stream.chunks {
				}
				return
			}
		}
	}()
	return stream
}

func (stream *passiveByteStream) Write(payload []byte) (int, error) {
	if len(payload) == 0 || stream.dropped.Load() {
		return len(payload), nil
	}
	copyOfPayload := append([]byte(nil), payload...)
	select {
	case stream.chunks <- copyOfPayload:
	default:
		stream.dropped.Store(true)
	}
	return len(payload), nil
}

func (stream *passiveByteStream) close() {
	stream.once.Do(func() { close(stream.chunks) })
}

func (gateway *protocolGateway) serveHTTP1(client, upstream net.Conn, route *dialedUpstream, destination, scheme string) error {
	requests := newPassiveByteStream()
	responses := newPassiveByteStream()
	captureDone := make(chan struct{})
	go func() {
		defer close(captureDone)
		gateway.observeHTTP1(requests, responses, route, destination, scheme)
	}()
	relayErr := relayObserved(client, upstream, requests, responses)
	requests.close()
	responses.close()
	<-captureDone
	return relayErr
}

func relayObserved(client, upstream net.Conn, clientObserver, upstreamObserver io.Writer) error {
	type copyResult struct {
		err        error
		halfClosed bool
		request    bool
	}
	results := make(chan copyResult, 2)
	copyDirection := func(request bool, destination net.Conn, source net.Conn, observer io.Writer) {
		_, err := io.Copy(destination, io.TeeReader(source, observer))
		halfClosed := false
		if halfCloser, ok := destination.(interface{ CloseWrite() error }); ok {
			halfClosed = halfCloser.CloseWrite() == nil
		}
		results <- copyResult{err: err, halfClosed: halfClosed, request: request}
	}
	go copyDirection(true, upstream, client, clientObserver)
	go copyDirection(false, client, upstream, upstreamObserver)
	first := <-results
	interruptedPeer := false
	if !first.request || !first.halfClosed {
		interruptedPeer = true
		if first.request {
			_ = upstream.SetReadDeadline(time.Now())
		} else {
			_ = client.SetReadDeadline(time.Now())
		}
	}
	second := <-results
	if first.err != nil && !isClosedConnectionError(first.err) {
		return first.err
	}
	if second.err != nil && !isClosedConnectionError(second.err) && !interruptedPeer {
		return second.err
	}
	return nil
}

func isClosedConnectionError(err error) bool {
	return err == nil || errors.Is(err, net.ErrClosed) || strings.Contains(err.Error(), "use of closed network connection")
}

func (gateway *protocolGateway) observeHTTP1(
	requests *passiveByteStream,
	responses *passiveByteStream,
	route *dialedUpstream,
	destination, scheme string,
) {
	defer requests.reader.Close()
	defer responses.reader.Close()
	clientReader := bufio.NewReader(requests.reader)
	serverReader := bufio.NewReader(responses.reader)
	for {
		started := time.Now()
		request, err := http.ReadRequest(clientReader)
		if err != nil {
			if err != io.EOF && !requests.dropped.Load() {
				log.Printf("observe HTTP request: %v", err)
			}
			return
		}
		replay := route.replay
		lease := gateway.beginCapture()
		requestCapture := &limitedCapture{limit: gateway.captureLimit()}
		if request.Body != nil {
			_, requestErr := io.Copy(io.Discard, io.TeeReader(request.Body, captureWriterFunc(requestCapture.write)))
			_ = request.Body.Close()
			if requestErr != nil {
				gateway.prepareCapturedRequest(request, scheme)
				gateway.persistHTTP(lease, request, nil, route, replay, destination, scheme, started, requestCapture, &limitedCapture{limit: gateway.captureLimit()}, requestErr.Error())
				return
			}
		}
		gateway.prepareCapturedRequest(request, scheme)
		response, err := http.ReadResponse(serverReader, request)
		if err != nil {
			gateway.persistHTTP(lease, request, nil, route, replay, destination, scheme, started, requestCapture, &limitedCapture{limit: gateway.captureLimit()}, err.Error())
			return
		}
		responseCapture := &limitedCapture{limit: gateway.captureLimit()}
		if response.Body != nil {
			_, responseErr := io.Copy(io.Discard, io.TeeReader(response.Body, captureWriterFunc(responseCapture.write)))
			_ = response.Body.Close()
			if responseErr != nil {
				gateway.persistHTTP(lease, request, response, route, replay, destination, scheme, started, requestCapture, responseCapture, responseErr.Error())
				return
			}
		}
		gateway.persistHTTP(lease, request, response, route, replay, destination, scheme, started, requestCapture, responseCapture, "")
		if response.StatusCode == http.StatusSwitchingProtocols {
			return
		}
		if request.Close || response.Close {
			return
		}
	}
}

func (gateway *protocolGateway) beginCapture() *captureLease {
	if gateway.capture == nil {
		return &captureLease{}
	}
	lease, err := gateway.capture.begin()
	if err != nil {
		log.Printf("begin HTTP capture: %v", err)
		return &captureLease{}
	}
	return lease
}

func (gateway *protocolGateway) prepareCapturedRequest(request *http.Request, scheme string) {
	request.RequestURI = ""
	if request.URL != nil {
		request.URL.Scheme = scheme
		request.URL.Host = request.Host
	}
}

func (gateway *protocolGateway) serveHTTP2(client, upstream net.Conn, route *dialedUpstream, destination, scheme string, tlsUpstream bool) error {
	used := atomic.Bool{}
	transport := &http2.Transport{
		AllowHTTP: !tlsUpstream,
		DialTLSContext: func(context.Context, string, string, *tls.Config) (net.Conn, error) {
			if !used.CompareAndSwap(false, true) {
				return nil, fmt.Errorf("HTTP/2 upstream connection already assigned")
			}
			return upstream, nil
		},
	}
	handler := http.HandlerFunc(func(responseWriter http.ResponseWriter, request *http.Request) {
		started := time.Now()
		replay := route.replay
		lease, err := gateway.capture.begin()
		if err != nil {
			log.Printf("begin HTTP capture: %v", err)
			lease = &captureLease{}
		}
		requestCapture := &limitedCapture{limit: gateway.captureLimit()}
		if request.Body != nil {
			request.Body = &capturingReadCloser{ReadCloser: request.Body, capture: requestCapture}
		}
		request.URL.Scheme = scheme
		request.URL.Host = request.Host
		request.RequestURI = ""
		response, err := transport.RoundTrip(request)
		if err != nil {
			http.Error(responseWriter, "upstream connection failed", http.StatusBadGateway)
			gateway.persistHTTP(lease, request, nil, route, replay, destination, scheme, started, requestCapture, &limitedCapture{limit: gateway.captureLimit()}, err.Error())
			return
		}
		defer response.Body.Close()
		for name, values := range response.Header {
			for _, value := range values {
				responseWriter.Header().Add(name, value)
			}
		}
		responseWriter.WriteHeader(response.StatusCode)
		responseCapture := &limitedCapture{limit: gateway.captureLimit()}
		_, copyErr := io.Copy(responseWriter, io.TeeReader(response.Body, captureWriterFunc(responseCapture.write)))
		errorText := ""
		if copyErr != nil {
			errorText = copyErr.Error()
		}
		gateway.persistHTTP(lease, request, response, route, replay, destination, scheme, started, requestCapture, responseCapture, errorText)
	})
	server := &http2.Server{}
	server.ServeConn(client, &http2.ServeConnOpts{Handler: handler})
	transport.CloseIdleConnections()
	return nil
}

type captureWriterFunc func([]byte)

func (writer captureWriterFunc) Write(payload []byte) (int, error) {
	writer(payload)
	return len(payload), nil
}

func (gateway *protocolGateway) persistHTTP(
	lease *captureLease,
	request *http.Request,
	response *http.Response,
	route *dialedUpstream,
	replay replayContext,
	destination, scheme string,
	started time.Time,
	requestCapture, responseCapture *limitedCapture,
	errorText string,
) {
	sequence := gateway.sequence.Add(1)
	flowID := gateway.taskRef + ":flow:" + strconv.FormatUint(sequence, 10)
	flow := newCapturedHTTPFlow(flowID, gateway.taskRef, gateway.runRef, route.routeRef, route.connectionRef, scheme, request.Proto, started)
	if replay.ReplayOf != "" {
		flow.ReplayOf = replay.ReplayOf
		flow.Attribution = replay.Attribution
		flow.RuntimeRef = replay.RuntimeRef
		flow.SessionRef = replay.ConnectionRef
		if replay.TaskRef != "" {
			flow.TaskRef = replay.TaskRef
		}
		if replay.RunRef != "" {
			flow.RunRef = replay.RunRef
		}
		if replay.RouteRef != "" {
			flow.RouteRef = replay.RouteRef
		}
		if replay.ConnectionRef != "" {
			flow.ConnectionRef = replay.ConnectionRef
		}
	}
	flow.Method = request.Method
	flow.Host = request.Host
	flow.URL = request.URL.String()
	flow.RequestHeaders = headerPairs(request.Header)
	flow.RequestObservedBytes = requestCapture.observed
	flow.RequestTruncated = requestCapture.observed > int64(requestCapture.payload.Len())
	flow.Error = errorText
	if response != nil {
		flow.Status = response.StatusCode
		flow.ResponseHeaders = headerPairs(response.Header)
	}
	flow.ResponseObservedBytes = responseCapture.observed
	flow.ResponseTruncated = responseCapture.observed > int64(responseCapture.payload.Len())
	flow.complete(started, requestCapture.payload.Bytes(), responseCapture.payload.Bytes())
	if err := lease.finish(flow); err != nil {
		log.Printf("persist HTTP capture: %v", err)
	}
}

func claimReplayContext(path string) replayContext {
	return claimReplayContextForUID(path, 1000)
}

func claimReplayContextForUID(path string, expectedUID uint32) replayContext {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return replayContext{}
	}
	defer file.Close()
	details, err := file.Stat()
	if err != nil || !details.Mode().IsRegular() || details.Size() > 64<<10 {
		return replayContext{}
	}
	stat, ok := details.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != expectedUID {
		return replayContext{}
	}
	payload, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	_ = os.Remove(path)
	if err != nil {
		return replayContext{}
	}
	var value replayContext
	if json.Unmarshal(payload, &value) != nil || !validReplayContext(value) {
		return replayContext{}
	}
	return value
}

func validReplayContext(value replayContext) bool {
	if value.ReplayOf == "" || len(value.ReplayOf) > 1024 {
		return false
	}
	for _, item := range []string{value.RuntimeRef, value.TaskRef, value.RunRef, value.RouteRef, value.ConnectionRef, value.Attribution} {
		if len(item) > 512 {
			return false
		}
		for _, character := range item {
			if character < 32 {
				return false
			}
		}
	}
	return true
}

func headerPairs(header http.Header) [][2]string {
	pairs := make([][2]string, 0, len(header))
	for name, values := range header {
		for _, value := range values {
			pairs = append(pairs, [2]string{name, value})
		}
	}
	return pairs
}

func (gateway *protocolGateway) captureLimit() int {
	if gateway.bodyLimit > 0 {
		return gateway.bodyLimit
	}
	return protocolCaptureLimit
}
