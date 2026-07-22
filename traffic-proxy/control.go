package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const protocolVersion = 1
const controlSocketPathMaxBytes = 103

type Context struct {
	RuntimeRef  string `json:"runtime_ref"`
	TaskRef     string `json:"task_ref"`
	RunRef      string `json:"run_ref"`
	Attribution string `json:"attribution"`
	RouteRef    string `json:"route_ref"`
	SessionRef  string `json:"session_ref"`
}
type State struct {
	mu       sync.RWMutex
	ctx      Context
	started  time.Time
	requests uint64
}

func NewState(runtimeRef string) *State {
	return &State{started: time.Now(), ctx: Context{RuntimeRef: runtimeRef}}
}
func (s *State) Get() Context { s.mu.RLock(); defer s.mu.RUnlock(); return s.ctx }
func (s *State) Set(field, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch field {
	case "runtime_ref":
		if value != s.ctx.RuntimeRef {
			return errors.New("runtime_ref is fixed for this process")
		}
	case "task_ref":
		s.ctx.TaskRef = value
		s.ctx.RunRef = ""
	case "run_ref":
		s.ctx.RunRef = value
	case "attribution":
		s.ctx.Attribution = value
	case "route_ref":
		s.ctx.RouteRef = value
	case "session_ref":
		s.ctx.SessionRef = value
	default:
		return fmt.Errorf("unknown field %q", field)
	}
	return nil
}
func (s *State) Clear(field string) error {
	if field == "runtime_ref" {
		return errors.New("runtime_ref cannot be cleared")
	}
	return s.Set(field, "")
}
func (s *State) Inc() { s.mu.Lock(); s.requests++; s.mu.Unlock() }

type controlRequest struct {
	Version    int            `json:"version"`
	ID         string         `json:"id,omitempty"`
	Command    string         `json:"command"`
	Field      string         `json:"field,omitempty"`
	Value      string         `json:"value,omitempty"`
	Cursor     string         `json:"cursor,omitempty"`
	Limit      int            `json:"limit,omitempty"`
	ByteLimit  int64          `json:"byte_limit,omitempty"`
	ExchangeID int64          `json:"exchange_id,omitempty"`
	Side       string         `json:"side,omitempty"`
	Filter     HistoryFilter  `json:"filter,omitempty"`
	Method     string         `json:"method,omitempty"`
	URL        string         `json:"url,omitempty"`
	Headers    *[]HeaderEntry `json:"headers,omitempty"`
	Body       *ReplayBody    `json:"body,omitempty"`
	RouteRef   string         `json:"route_ref,omitempty"`
	SessionRef string         `json:"session_ref,omitempty"`
	Context    *Context       `json:"context,omitempty"`
}
type controlResponse struct {
	Version   int    `json:"version"`
	ID        string `json:"id,omitempty"`
	OK        bool   `json:"ok"`
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
}

func listenControl(path string) (net.Listener, error) {
	if len([]byte(path)) > controlSocketPathMaxBytes {
		return nil, fmt.Errorf("control socket path is %d bytes; maximum is %d: %s", len([]byte(path)), controlSocketPathMaxBytes, path)
	}
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("control socket parent must not be a symlink")
	}
	if !info.IsDir() {
		return nil, errors.New("control socket parent is not a directory")
	}
	if info.Mode().Perm()&0022 != 0 {
		return nil, errors.New("control socket parent must not be group/world writable")
	}
	existing, err := os.Lstat(path)
	if err == nil {
		if existing.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("control socket path must not be a symlink")
		}
		if existing.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("control socket path exists and is not a Unix socket")
		}
		probe, dialErr := net.DialTimeout("unix", path, 200*time.Millisecond)
		if dialErr == nil {
			_ = probe.Close()
			return nil, errors.New("control socket is already active")
		}
		if err = os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}
func serveControl(ln net.Listener, state *State, shutdown func(), services ...any) {
	var store *Store
	var proxy *Proxy
	var proxyAddress string
	for _, service := range services {
		switch value := service.(type) {
		case *Store:
			store = value
		case *Proxy:
			proxy = value
		case string:
			proxyAddress = value
		}
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handleControl(c, state, shutdown, store, proxy, proxyAddress)
	}
}

func sendControl(c net.Conn, resp controlResponse) bool {
	const maxResponse = 1 << 20
	b, err := json.Marshal(resp)
	if err != nil || len(b)+1 > maxResponse {
		b, _ = json.Marshal(controlResponse{Version: protocolVersion, ID: resp.ID, Error: "response exceeds control limit"})
	}
	b = append(b, '\n')
	_, err = c.Write(b)
	return err == nil
}

func handleControl(c net.Conn, state *State, shutdown func(), store *Store, proxy *Proxy, proxyAddress string) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	scanner := bufio.NewScanner(c)
	scanner.Buffer(make([]byte, 1024), 64<<10)
	for scanner.Scan() {
		var req controlRequest
		resp := controlResponse{Version: protocolVersion}
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			resp.Error = "invalid JSON"
			if !sendControl(c, resp) {
				return
			}
			continue
		}
		resp.ID = req.ID
		if req.Version != protocolVersion {
			resp.Error = "unsupported version"
			if !sendControl(c, resp) {
				return
			}
			continue
		}
		var err error
		switch req.Command {
		case "hello":
			resp.OK = true
			resp.Result = map[string]any{"protocol": "traffic-proxy-control", "version": protocolVersion, "runtime_ref": state.Get().RuntimeRef, "proxy": proxyAddress}
		case "health":
			resp.OK = true
			resp.Result = map[string]any{"status": "ok", "runtime_ref": state.Get().RuntimeRef}
		case "status":
			state.mu.RLock()
			resp.OK = true
			resp.Result = map[string]any{"uptime_seconds": int64(time.Since(state.started).Seconds()), "requests": state.requests, "context": state.ctx}
			state.mu.RUnlock()
		case "set":
			if req.Value == "" || badText(req.Value) {
				err = errors.New("value must be non-empty and contain no control characters")
			} else {
				err = state.Set(req.Field, req.Value)
			}
		case "clear":
			err = state.Clear(req.Field)
		case "history_list":
			if store == nil {
				err = errors.New("history unavailable")
			} else {
				resp.Result, err = store.HistoryList(req.Cursor, req.Limit, req.Filter)
			}
		case "history_get":
			if store == nil {
				err = errors.New("history unavailable")
			} else {
				resp.Result, err = store.HistoryGet(req.ExchangeID)
			}
		case "history_body":
			if store == nil {
				err = errors.New("history unavailable")
			} else {
				resp.Result, err = store.HistoryBody(req.ExchangeID, req.Side, req.ByteLimit)
			}
		case "replay":
			if proxy == nil {
				err = replayError("replay_unavailable", "replay unavailable")
			} else {
				resp.Result, err = proxy.Replay(context.Background(), ReplayRequest{ExchangeID: req.ExchangeID, Method: req.Method, URL: req.URL, Headers: req.Headers, Body: req.Body, RouteRef: req.RouteRef, SessionRef: req.SessionRef, Context: req.Context})
			}
		case "shutdown":
			resp.OK = true
			sendControl(c, resp)
			go shutdown()
			return
		default:
			err = errors.New("unknown command")
		}
		if err != nil {
			resp.Error = err.Error()
			var replayErr *ReplayError
			if errors.As(err, &replayErr) {
				resp.ErrorCode = replayErr.Code
			}
			if req.Command != "replay" {
				resp.Result = nil
			}
		} else if req.Command != "set" && req.Command != "clear" || err == nil {
			resp.OK = true
		}
		if !sendControl(c, resp) {
			return
		}
	}
	if scanner.Err() != nil {
		sendControl(c, controlResponse{Version: protocolVersion, Error: "request frame exceeds 65536 bytes"})
	}
}
