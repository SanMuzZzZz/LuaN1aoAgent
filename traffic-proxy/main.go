package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func generatedRuntimeRef() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Fatal(err)
	}
	return hex.EncodeToString(b)
}
func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP proxy listen address")
	data := flag.String("data-dir", "./data", "database and blob directory")
	control := flag.String("control-socket", "", "Unix control socket (default: data-dir/control.sock)")
	quota := flag.Int64("quota-bytes", 1<<30, "approximate runtime data quota; 0 disables rotation")
	capture := flag.Int64("capture-bytes", 1<<20, "maximum captured bytes per request/response body")
	headers := flag.Int64("header-bytes", 64<<10, "maximum persisted header name/value bytes per exchange side")
	exchangeCap := flag.Int64("exchange-cap", 100000, "maximum retained exchanges; 0 disables")
	runtimeRef := flag.String("runtime-ref", "", "fixed runtime identity (generated when omitted)")
	connectMode := flag.String("connect-mode", "mitm", "CONNECT handling: mitm or passthrough")
	flag.Parse()
	if *capture < 0 || *quota < 0 || *headers < 0 || *exchangeCap < 0 {
		log.Fatal("limits must be non-negative")
	}
	if *connectMode != "mitm" && *connectMode != "passthrough" {
		log.Fatal("connect-mode must be mitm or passthrough")
	}
	if *runtimeRef == "" {
		*runtimeRef = generatedRuntimeRef()
	}
	if badText(*runtimeRef) {
		log.Fatal("runtime-ref contains control characters")
	}
	if err := securePrivateDir(*data); err != nil {
		log.Fatal(err)
	}
	if *control == "" {
		*control = filepath.Join(*data, "control.sock")
	}
	store, err := OpenStore(*data, *quota, *exchangeCap)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	ca, err := OpenCertificateAuthority(*data, *runtimeRef)
	if err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	self, err := normalizeListen(ln.Addr().String())
	if err != nil {
		ln.Close()
		log.Fatal(err)
	}
	state := NewState(*runtimeRef)
	dialer := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	proxy := &Proxy{Store: store, State: state, Transport: transport, CaptureLimit: *capture, HeaderLimit: *headers, Dialer: dialer, Self: self, CA: ca, ConnectMode: *connectMode}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	ctl, err := listenControl(*control)
	if err != nil {
		ln.Close()
		log.Fatal(err)
	}
	defer os.Remove(*control)
	stop := make(chan struct{})
	shutdown := func() {
		select {
		case <-stop:
			return
		default:
			close(stop)
		}
	}
	go serveControl(ctl, state, shutdown, store, proxy, ln.Addr().String())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case <-sig:
			shutdown()
		case <-stop:
		}
	}()
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("server: %v", err)
			shutdown()
		}
	}()
	fmt.Printf("proxy=%s control=%s data=%s runtime_ref=%s\n", ln.Addr(), *control, *data, *runtimeRef)
	<-stop
	ctl.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("HTTP shutdown: %v", err)
	}
	if err := proxy.Shutdown(ctx); err != nil {
		log.Printf("CONNECT shutdown: %v", err)
	}
}
