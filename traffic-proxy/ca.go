package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const caProductName = "LuaN1ao Traffic Proxy"

type CertificateAuthority struct {
	cert      *x509.Certificate
	key       *ecdsa.PrivateKey
	certPEM   []byte
	mu        sync.Mutex
	leafCache map[string]*tls.Certificate
}

func OpenCertificateAuthority(dataDir, runtimeRef string) (*CertificateAuthority, error) {
	if runtimeRef == "" || badText(runtimeRef) || strings.ContainsAny(runtimeRef, `/\\`) {
		return nil, errors.New("invalid runtime_ref for CA storage")
	}
	if err := securePrivateDir(dataDir); err != nil {
		return nil, fmt.Errorf("validate data directory: %w", err)
	}
	caDir := filepath.Join(dataDir, "ca")
	if err := securePrivateDir(caDir); err != nil {
		return nil, fmt.Errorf("validate CA directory: %w", err)
	}
	dir := filepath.Join(caDir, runtimeRef)
	if err := securePrivateDir(dir); err != nil {
		return nil, fmt.Errorf("validate runtime CA directory: %w", err)
	}
	certPath, keyPath := filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key")
	if err := requireRegularOrAbsent(certPath); err != nil {
		return nil, err
	}
	if err := requireRegularOrAbsent(keyPath); err != nil {
		return nil, err
	}
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil {
		if err := requirePrivateMode(keyPath); err != nil {
			return nil, err
		}
		pair, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			return nil, fmt.Errorf("load runtime CA: %w", err)
		}
		cert, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return nil, fmt.Errorf("parse runtime CA: %w", err)
		}
		key, ok := pair.PrivateKey.(*ecdsa.PrivateKey)
		if !ok || !cert.IsCA || time.Now().After(cert.NotAfter) {
			return nil, errors.New("stored runtime CA is invalid or expired")
		}
		return &CertificateAuthority{cert: cert, key: key, certPEM: certPEM, leafCache: make(map[string]*tls.Certificate)}, nil
	}
	if !errors.Is(certErr, os.ErrNotExist) || !errors.Is(keyErr, os.ErrNotExist) {
		return nil, errors.New("runtime CA certificate and key must both exist or both be absent")
	}
	return createCertificateAuthority(dir, certPath, keyPath, runtimeRef)
}

func securePrivateDir(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err = os.Mkdir(path, 0700); err != nil {
			return err
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s must be a real directory", path)
	}
	if info.Mode().Perm() != 0700 {
		if err = os.Chmod(path, 0700); err != nil {
			return err
		}
	}
	return nil
}

func requireRegularOrAbsent(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("%s must be a regular file", path)
	}
	return nil
}

func requirePrivateMode(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("runtime CA private key %s must be a regular file", path)
	}
	if info.Mode().Perm() != 0600 {
		return fmt.Errorf("runtime CA private key %s must have mode 0600", path)
	}
	return nil
}

func createCertificateAuthority(dir, certPath, keyPath, runtimeRef string) (*CertificateAuthority, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{Organization: []string{caProductName}, CommonName: caProductName + " Runtime CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(5, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature, MaxPathLen: 0}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err = atomicPrivateFile(dir, keyPath, keyPEM, 0600); err != nil {
		return nil, err
	}
	if err = atomicPrivateFile(dir, certPath, certPEM, 0644); err != nil {
		_ = os.Remove(keyPath)
		return nil, err
	}
	return &CertificateAuthority{cert: cert, key: key, certPEM: certPEM, leafCache: make(map[string]*tls.Certificate)}, nil
}

func atomicPrivateFile(dir, path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(filepath.Join(dir, ".tmp-"+filepath.Base(path)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		f.Close()
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func (ca *CertificateAuthority) CertificatePEM() []byte { return append([]byte(nil), ca.certPEM...) }

func (ca *CertificateAuthority) Leaf(host string) (*tls.Certificate, error) {
	host = strings.TrimSuffix(strings.TrimSpace(host), ".")
	if host == "" || badText(host) {
		return nil, errors.New("invalid leaf certificate host")
	}
	keyName := strings.ToLower(host)
	ca.mu.Lock()
	defer ca.mu.Unlock()
	if cert := ca.leafCache[keyName]; cert != nil {
		return cert, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	notAfter := now.AddDate(0, 0, 30)
	if notAfter.After(ca.cert.NotAfter) {
		notAfter = ca.cert.NotAfter
	}
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{Organization: []string{caProductName}, CommonName: host}, NotBefore: now.Add(-5 * time.Minute), NotAfter: notAfter, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	cert := &tls.Certificate{Certificate: [][]byte{der, ca.cert.Raw}, PrivateKey: key}
	ca.leafCache[keyName] = cert
	return cert, nil
}
