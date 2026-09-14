package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

var hostBrokerMagic = []byte("LNDB1")

// brokerTransportError reports a failure of the gateway→broker transport
// itself. It deliberately does not wrap the underlying error: the broker is
// local infrastructure, so its failures must surface as a TCP reset to the
// executor instead of being classified as a filtered target (timeouts would
// otherwise match shouldResetTCP's silent-drop branch and blackhole the flow).
type brokerTransportError struct {
	message string
}

func (e *brokerTransportError) Error() string { return e.message }

func newBrokerTransportError(format string, args ...any) *brokerTransportError {
	return &brokerTransportError{message: fmt.Sprintf(format, args...)}
}

func dialHostBroker(ctx context.Context, brokerAddress, token, destination string, timeout time.Duration) (net.Conn, error) {
	tokenBytes, err := hex.DecodeString(token)
	if err != nil || len(tokenBytes) != 32 {
		return nil, fmt.Errorf("invalid host broker token")
	}
	host, rawPort, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, fmt.Errorf("invalid host broker destination: %w", err)
	}
	address := net.ParseIP(host).To4()
	port, err := strconv.Atoi(rawPort)
	if address == nil || err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("host broker destination must be IPv4")
	}
	connectContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(connectContext, "tcp", brokerAddress)
	if err != nil {
		return nil, newBrokerTransportError("connect host broker: %v", err)
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = connection.Close()
		}
	}()
	request := make([]byte, 0, len(hostBrokerMagic)+32+4+2)
	request = append(request, hostBrokerMagic...)
	request = append(request, tokenBytes...)
	request = append(request, address...)
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	request = append(request, portBytes...)
	if deadline, ok := connectContext.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	for len(request) > 0 {
		written, err := connection.Write(request)
		if err != nil {
			return nil, newBrokerTransportError("write host broker request: %v", err)
		}
		if written == 0 {
			return nil, newBrokerTransportError("write host broker request made no progress")
		}
		request = request[written:]
	}
	reply := []byte{0xff}
	if _, err := io.ReadFull(connection, reply); err != nil {
		return nil, newBrokerTransportError("read host broker reply: %v", err)
	}
	switch reply[0] {
	case 0:
		_ = connection.SetDeadline(time.Time{})
		succeeded = true
		return connection, nil
	case 2:
		return nil, context.DeadlineExceeded
	default:
		return nil, fmt.Errorf("host target refused connection")
	}
}
