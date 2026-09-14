package main

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestHostBrokerDialWaitsForAuthenticatedSuccess(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	token := make([]byte, 32)
	for index := range token {
		token[index] = byte(index)
	}
	requestSeen := make(chan []byte, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		request := make([]byte, 43)
		if _, readErr := io.ReadFull(connection, request); readErr != nil {
			return
		}
		requestSeen <- request
		_, _ = connection.Write([]byte{0})
		payload := make([]byte, 4)
		_, _ = io.ReadFull(connection, payload)
		_, _ = connection.Write(payload)
	}()
	connection, err := dialHostBroker(
		context.Background(), listener.Addr().String(), hex.EncodeToString(token), "192.0.2.10:31337", time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := <-requestSeen
	if string(request[:5]) != "LNDB1" || !net.IP(request[37:41]).Equal(net.ParseIP("192.0.2.10")) {
		t.Fatalf("broker request = %x", request)
	}
	if _, err := connection.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("relay reply = %q, error = %v", reply, err)
	}
}

func TestHostBrokerTransportFailureResets(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		// Simulate the observed outage: the broker accepts the connection but
		// its handshake never completes and it eventually destroys the socket.
		deadline := time.Now().Add(50 * time.Millisecond)
		_ = connection.SetReadDeadline(deadline)
		buffer := make([]byte, 64)
		for {
			if _, readErr := connection.Read(buffer); readErr != nil {
				_ = connection.Close()
				return
			}
		}
	}()
	token := make([]byte, 32)
	_, err = dialHostBroker(
		context.Background(), listener.Addr().String(), hex.EncodeToString(token), "192.0.2.10:31337", time.Second,
	)
	if err == nil {
		t.Fatal("expected a transport failure from the silent broker")
	}
	var transport *brokerTransportError
	if !errors.As(err, &transport) {
		t.Fatalf("dialHostBroker error = %T (%v), want *brokerTransportError", err, err)
	}
	if !shouldResetTCP(err) {
		t.Fatalf("broker transport failure must reset the flow, got silent drop for: %v", err)
	}
}

func TestShouldResetTCPClassifiesBrokerInfraAsReset(t *testing.T) {
	// A deadline miss on the broker transport is infrastructure, not a
	// filtered target, and must reset.
	transportTimeout := newBrokerTransportError("connect host broker: %v", &fakeNetError{timeout: true})
	if !shouldResetTCP(transportTimeout) {
		t.Fatal("broker transport timeout must reset")
	}
	// The broker's target-timeout reply stays silent: that is the target's
	// own filtered-port behavior relayed honestly.
	if shouldResetTCP(context.DeadlineExceeded) {
		t.Fatal("broker target-timeout reply must stay silent")
	}
	if shouldResetTCP(&fakeNetError{timeout: true}) {
		t.Fatal("plain network timeouts keep the filtered-target semantics")
	}
}

type fakeNetError struct{ timeout bool }

func (e *fakeNetError) Error() string { return "fake net error" }
func (e *fakeNetError) Timeout() bool { return e.timeout }
func (e *fakeNetError) Temporary() bool { return false }
