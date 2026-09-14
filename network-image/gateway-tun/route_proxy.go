package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

type networkRoute struct {
	RouteRef      string `json:"routeRef"`
	CIDR          string `json:"cidr"`
	PrefixLength  int    `json:"prefixLength"`
	SocksHost     string `json:"socksHost"`
	SocksPort     int    `json:"socksPort"`
	ConnectionRef string `json:"connectionRef,omitempty"`
	prefix        netip.Prefix
}

type routeSnapshot struct {
	Routes []networkRoute `json:"routes"`
}

type routeStore struct {
	path string
}

func writePrecreatedReadyFile(path string) error {
	return os.WriteFile(path, []byte("ready\n"), 0o600)
}

func (store routeStore) load() ([]networkRoute, error) {
	payload, err := os.ReadFile(store.path)
	if err != nil {
		return nil, fmt.Errorf("read route snapshot: %w", err)
	}
	var snapshot routeSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		return nil, fmt.Errorf("decode route snapshot: %w", err)
	}
	if snapshot.Routes == nil {
		return nil, errors.New("route snapshot has no routes array")
	}
	for index := range snapshot.Routes {
		route := &snapshot.Routes[index]
		if route.RouteRef == "" {
			return nil, fmt.Errorf("route %d has no routeRef", index)
		}
		prefix, err := netip.ParsePrefix(route.CIDR)
		if err != nil || !prefix.Addr().Is4() {
			return nil, fmt.Errorf("route %s has invalid IPv4 CIDR %q", route.RouteRef, route.CIDR)
		}
		if route.PrefixLength != prefix.Bits() {
			return nil, fmt.Errorf("route %s prefixLength does not match CIDR", route.RouteRef)
		}
		if route.SocksHost == "" || route.SocksPort < 1 || route.SocksPort > 65535 {
			return nil, fmt.Errorf("route %s has invalid SOCKS endpoint", route.RouteRef)
		}
		route.prefix = prefix.Masked()
	}
	sort.SliceStable(snapshot.Routes, func(left int, right int) bool {
		return snapshot.Routes[left].prefix.Bits() > snapshot.Routes[right].prefix.Bits()
	})
	return snapshot.Routes, nil
}

func (store routeStore) match(destination string) (*networkRoute, error) {
	routes, err := store.load()
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, fmt.Errorf("invalid destination %q: %w", destination, err)
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return nil, nil
	}
	address = address.Unmap()
	for index := range routes {
		if routes[index].prefix.Contains(address) {
			return &routes[index], nil
		}
	}
	return nil, nil
}

type directDialFunc func(context.Context, string, string) (net.Conn, error)
type socksDialFunc func(context.Context, string, string, time.Duration) (net.Conn, error)

type routeDialer struct {
	routes              routeStore
	connectTimeout      time.Duration
	directDial          directDialFunc
	socksDial           socksDialFunc
	selfTargets         []string
	brokerAddress       string
	brokerToken         string
	localDirect         map[netip.Addr]struct{}
	localDenyPorts      map[uint16]struct{}
	denyPrefixes        []netip.Prefix
	allowPrefixes       []netip.Prefix
	allowDomainResolved bool
}

func newRouteDialer(routesFile string, connectTimeout time.Duration, selfTargets ...string) *routeDialer {
	return &routeDialer{
		routes:         routeStore{path: routesFile},
		connectTimeout: connectTimeout,
		directDial:     (&net.Dialer{}).DialContext,
		socksDial:      dialSOCKS5,
		selfTargets:    selfTargets,
	}
}

func (dialer *routeDialer) dial(ctx context.Context, destination string) (net.Conn, error) {
	connection, _, err := dialer.dialWithRoute(ctx, destination)
	return connection, err
}

func (dialer *routeDialer) dialWithRoute(ctx context.Context, destination string) (net.Conn, *networkRoute, error) {
	for _, target := range dialer.selfTargets {
		if sameInfrastructureEndpoint(destination, target) {
			return nil, nil, fmt.Errorf("refusing recursive gateway dial to %s", destination)
		}
	}
	if dialer.denied(destination) {
		return nil, nil, fmt.Errorf("destination %s is protected gateway infrastructure", destination)
	}
	route, err := dialer.routes.match(destination)
	if err != nil {
		return nil, nil, err
	}
	if route == nil {
		if !dialer.directAllowed(destination) {
			return nil, nil, fmt.Errorf("destination %s is outside authorized scope", destination)
		}
		if dialer.isLocalDirect(destination) {
			_, rawPort, _ := net.SplitHostPort(destination)
			port, _ := strconv.Atoi(rawPort)
			if _, denied := dialer.localDenyPorts[uint16(port)]; denied {
				return nil, nil, fmt.Errorf("destination %s is a protected host service", destination)
			}
			connectContext, cancel := context.WithTimeout(ctx, dialer.connectTimeout)
			defer cancel()
			connection, err := dialer.directDial(connectContext, "tcp", destination)
			return connection, nil, err
		}
		if dialer.brokerAddress != "" {
			connection, err := dialHostBroker(ctx, dialer.brokerAddress, dialer.brokerToken, destination, dialer.connectTimeout)
			return connection, nil, err
		}
		connectContext, cancel := context.WithTimeout(ctx, dialer.connectTimeout)
		defer cancel()
		connection, err := dialer.directDial(connectContext, "tcp", destination)
		return connection, nil, err
	}
	proxyAddress := net.JoinHostPort(route.SocksHost, strconv.Itoa(route.SocksPort))
	connection, err := dialer.socksDial(ctx, proxyAddress, destination, dialer.connectTimeout)
	if err != nil {
		// Deliberately not %w: a connector transport failure (including its
		// timeouts) is infrastructure, and must reset the flow instead of
		// masquerading as a filtered destination.
		return nil, route, fmt.Errorf("route %s failed: %v", route.RouteRef, err)
	}
	return connection, route, nil
}

func (dialer *routeDialer) directAllowed(destination string) bool {
	// Domain-derived addresses have already passed the task namespace's
	// fail-closed ipset guard before policy routing delivers TCP to this TUN.
	if dialer.allowDomainResolved {
		return true
	}
	host, _, err := net.SplitHostPort(destination)
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	address = address.Unmap()
	for _, prefix := range dialer.allowPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (dialer *routeDialer) denied(destination string) bool {
	host, _, err := net.SplitHostPort(destination)
	if err != nil {
		return true
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	address = address.Unmap()
	for _, prefix := range dialer.denyPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (dialer *routeDialer) isLocalDirect(destination string) bool {
	host, _, err := net.SplitHostPort(destination)
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	_, ok := dialer.localDirect[address.Unmap()]
	return ok
}

func sameInfrastructureEndpoint(destination string, target string) bool {
	destinationHost, destinationPort, destinationError := net.SplitHostPort(destination)
	targetHost, targetPort, targetError := net.SplitHostPort(target)
	if destinationError != nil || targetError != nil || destinationPort != targetPort {
		return false
	}
	destinationHost = strings.ToLower(destinationHost)
	targetHost = strings.ToLower(targetHost)
	if destinationHost == targetHost {
		return true
	}
	destinationAddress, destinationError := netip.ParseAddr(destinationHost)
	targetAddress, targetError := netip.ParseAddr(targetHost)
	if targetHost == "localhost" {
		return destinationHost == "localhost" || destinationError == nil && destinationAddress.IsLoopback()
	}
	if destinationHost == "localhost" && targetError == nil {
		return targetAddress.IsLoopback() || targetAddress.IsUnspecified()
	}
	if destinationError != nil || targetError != nil {
		return false
	}
	destinationAddress = destinationAddress.Unmap()
	targetAddress = targetAddress.Unmap()
	if targetAddress.IsLoopback() {
		return destinationAddress.IsLoopback()
	}
	if targetAddress.IsUnspecified() {
		return destinationAddress.IsLoopback() || destinationAddress.IsUnspecified()
	}
	return destinationAddress == targetAddress
}
