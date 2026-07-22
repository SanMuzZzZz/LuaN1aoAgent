package main

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	maxHistoryPage = 100
	maxBodyRead    = 256 << 10
)

type HistoryFilter struct {
	RuntimeRef    string `json:"runtime_ref,omitempty"`
	TaskRef       string `json:"task_ref,omitempty"`
	RunRef        string `json:"run_ref,omitempty"`
	RouteRef      string `json:"route_ref,omitempty"`
	SessionRef    string `json:"session_ref,omitempty"`
	StartedAfter  string `json:"started_after,omitempty"`
	StartedBefore string `json:"started_before,omitempty"`
	Mode          string `json:"mode,omitempty"`
	Method        string `json:"method,omitempty"`
	Host          string `json:"host,omitempty"`
	ConnectRef    string `json:"connect_ref,omitempty"`
	Error         string `json:"error,omitempty"`
	Status        *int   `json:"status,omitempty"`
}

type HeaderEntry struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	Ordinal int    `json:"ordinal"`
}

type Exchange struct {
	ID                       int64         `json:"id"`
	StartedAt                string        `json:"started_at"`
	CompletedAt              string        `json:"completed_at"`
	DurationMS               int64         `json:"duration_ms"`
	Method                   string        `json:"method"`
	URL                      string        `json:"url"`
	Host                     string        `json:"host"`
	Scheme                   string        `json:"scheme"`
	Protocol                 string        `json:"protocol"`
	Mode                     string        `json:"mode"`
	Status                   int           `json:"status"`
	RequestObservedBytes     int64         `json:"request_observed_bytes"`
	ResponseObservedBytes    int64         `json:"response_observed_bytes"`
	RequestCapturedBytes     int64         `json:"request_captured_bytes"`
	ResponseCapturedBytes    int64         `json:"response_captured_bytes"`
	RequestBodyRef           string        `json:"request_body_ref,omitempty"`
	ResponseBodyRef          string        `json:"response_body_ref,omitempty"`
	RequestCaptureState      string        `json:"request_capture_state"`
	ResponseCaptureState     string        `json:"response_capture_state"`
	RequestTruncated         bool          `json:"request_truncated"`
	ResponseTruncated        bool          `json:"response_truncated"`
	HeadersTruncated         bool          `json:"headers_truncated"`
	QuotaPressure            bool          `json:"quota_pressure"`
	RequestTruncationReason  string        `json:"request_truncation_reason,omitempty"`
	ResponseTruncationReason string        `json:"response_truncation_reason,omitempty"`
	HeaderTruncationReason   string        `json:"header_truncation_reason,omitempty"`
	Error                    string        `json:"error,omitempty"`
	RuntimeRef               string        `json:"runtime_ref,omitempty"`
	TaskRef                  string        `json:"task_ref,omitempty"`
	RunRef                   string        `json:"run_ref,omitempty"`
	Attribution              string        `json:"attribution,omitempty"`
	RouteRef                 string        `json:"route_ref,omitempty"`
	SessionRef               string        `json:"session_ref,omitempty"`
	ConnectRef               string        `json:"connect_ref,omitempty"`
	ConnectAuthority         string        `json:"connect_authority,omitempty"`
	ConnectHost              string        `json:"connect_host,omitempty"`
	ConnectPort              string        `json:"connect_port,omitempty"`
	EvictedExchanges         int64         `json:"evicted_exchanges"`
	ReplayOf                 int64         `json:"replay_of,omitempty"`
	ErrorCode                string        `json:"error_code,omitempty"`
	RequestHeaders           []HeaderEntry `json:"request_headers,omitempty"`
	ResponseHeaders          []HeaderEntry `json:"response_headers,omitempty"`
}

func historyCursor(id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(id, 10)))
}

func parseHistoryCursor(cursor string) (int64, error) {
	if cursor == "" {
		return 0, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || len(b) > 20 {
		return 0, errors.New("invalid history cursor")
	}
	id, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid history cursor")
	}
	return id, nil
}

func (s *Store) HistoryList(cursor string, limit int, f HistoryFilter) (map[string]any, error) {
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > maxHistoryPage {
		return nil, fmt.Errorf("history limit must be between 1 and %d", maxHistoryPage)
	}
	cursorID, err := parseHistoryCursor(cursor)
	if err != nil {
		return nil, err
	}
	where := []string{"1=1"}
	args := make([]any, 0, 16)
	if cursorID > 0 {
		where, args = append(where, "id < ?"), append(args, cursorID)
	}
	for _, item := range []struct{ column, value string }{{"runtime_ref", f.RuntimeRef}, {"task_ref", f.TaskRef}, {"run_ref", f.RunRef}, {"route_ref", f.RouteRef}, {"session_ref", f.SessionRef}, {"mode", f.Mode}, {"method", f.Method}, {"host", f.Host}, {"connect_ref", f.ConnectRef}, {"error", f.Error}} {
		if item.value != "" {
			if badText(item.value) {
				return nil, errors.New("history filter contains control characters")
			}
			where, args = append(where, item.column+" = ?"), append(args, item.value)
		}
	}
	for _, item := range []struct{ operator, value string }{{">=", f.StartedAfter}, {"<=", f.StartedBefore}} {
		if item.value == "" {
			continue
		}
		parsed, parseErr := time.Parse(time.RFC3339Nano, item.value)
		if parseErr != nil {
			return nil, errors.New("invalid history time filter")
		}
		where, args = append(where, "started_at "+item.operator+" ?"), append(args, parsed.UTC().Format(time.RFC3339Nano))
	}
	if f.Status != nil {
		if *f.Status < 0 || *f.Status > 999 {
			return nil, errors.New("invalid status filter")
		}
		where, args = append(where, "status = ?"), append(args, *f.Status)
	}
	args = append(args, limit+1)
	rows, err := s.db.Query(`SELECT id,started_at,completed_at,duration_ms,method,url,host,scheme,protocol,mode,status,request_observed_bytes,response_observed_bytes,request_captured_bytes,response_captured_bytes,request_body_ref,response_body_ref,request_capture_state,response_capture_state,request_truncated,response_truncated,request_truncation_reason,response_truncation_reason,headers_truncated,header_truncation_reason,error,runtime_ref,task_ref,run_ref,attribution,route_ref,session_ref,connect_ref,connect_authority,connect_host,connect_port,quota_pressure,evicted_exchanges,replay_of,error_code FROM exchanges WHERE `+strings.Join(where, " AND ")+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Exchange, 0, limit)
	for rows.Next() {
		x, err := scanExchange(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, x)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	result := map[string]any{"items": items, "has_more": false}
	if len(items) > limit {
		items = items[:limit]
		result["items"], result["has_more"], result["next_cursor"] = items, true, historyCursor(items[len(items)-1].ID)
	}
	return result, nil
}

type rowScanner interface{ Scan(...any) error }

func scanExchange(row rowScanner) (Exchange, error) {
	var x Exchange
	var rb, sb, rr, sr, hr, er, runtime, task, run, attr, route, session, cref, ca, ch, cp, errorCode sql.NullString
	var replayOf sql.NullInt64
	var rt, st, ht, qp int
	err := row.Scan(&x.ID, &x.StartedAt, &x.CompletedAt, &x.DurationMS, &x.Method, &x.URL, &x.Host, &x.Scheme, &x.Protocol, &x.Mode, &x.Status, &x.RequestObservedBytes, &x.ResponseObservedBytes, &x.RequestCapturedBytes, &x.ResponseCapturedBytes, &rb, &sb, &x.RequestCaptureState, &x.ResponseCaptureState, &rt, &st, &rr, &sr, &ht, &hr, &er, &runtime, &task, &run, &attr, &route, &session, &cref, &ca, &ch, &cp, &qp, &x.EvictedExchanges, &replayOf, &errorCode)
	if err != nil {
		return x, err
	}
	x.RequestBodyRef, x.ResponseBodyRef = rb.String, sb.String
	x.RequestTruncated, x.ResponseTruncated, x.HeadersTruncated, x.QuotaPressure = rt != 0, st != 0, ht != 0, qp != 0
	x.RequestTruncationReason, x.ResponseTruncationReason, x.HeaderTruncationReason = rr.String, sr.String, hr.String
	x.Error, x.RuntimeRef, x.TaskRef, x.RunRef, x.Attribution, x.RouteRef, x.SessionRef = er.String, runtime.String, task.String, run.String, attr.String, route.String, session.String
	x.ConnectRef, x.ConnectAuthority, x.ConnectHost, x.ConnectPort = cref.String, ca.String, ch.String, cp.String
	x.ReplayOf, x.ErrorCode = replayOf.Int64, errorCode.String
	return x, nil
}

func (s *Store) HistoryGet(id int64) (Exchange, error) {
	if id <= 0 {
		return Exchange{}, errors.New("exchange_id must be positive")
	}
	x, err := scanExchange(s.db.QueryRow(`SELECT id,started_at,completed_at,duration_ms,method,url,host,scheme,protocol,mode,status,request_observed_bytes,response_observed_bytes,request_captured_bytes,response_captured_bytes,request_body_ref,response_body_ref,request_capture_state,response_capture_state,request_truncated,response_truncated,request_truncation_reason,response_truncation_reason,headers_truncated,header_truncation_reason,error,runtime_ref,task_ref,run_ref,attribution,route_ref,session_ref,connect_ref,connect_authority,connect_host,connect_port,quota_pressure,evicted_exchanges,replay_of,error_code FROM exchanges WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Exchange{}, errors.New("exchange not found")
	}
	if err != nil {
		return Exchange{}, err
	}
	rows, err := s.db.Query(`SELECT side,ordinal,name,value FROM exchange_headers WHERE exchange_id=? ORDER BY side,ordinal`, id)
	if err != nil {
		return Exchange{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var side string
		var h HeaderEntry
		if err = rows.Scan(&side, &h.Ordinal, &h.Name, &h.Value); err != nil {
			return Exchange{}, err
		}
		if side == "request" {
			x.RequestHeaders = append(x.RequestHeaders, h)
		} else {
			x.ResponseHeaders = append(x.ResponseHeaders, h)
		}
	}
	return x, rows.Err()
}

func (s *Store) HistoryBody(id int64, side string, limit int64) (map[string]any, error) {
	if id <= 0 {
		return nil, errors.New("exchange_id must be positive")
	}
	if side != "request" && side != "response" {
		return nil, errors.New("body side must be request or response")
	}
	if limit == 0 {
		limit = maxBodyRead
	}
	if limit < 1 || limit > maxBodyRead {
		return nil, fmt.Errorf("body limit must be between 1 and %d", maxBodyRead)
	}
	column := "request_body_ref"
	if side == "response" {
		column = "response_body_ref"
	}
	var ref sql.NullString
	if err := s.db.QueryRow(`SELECT `+column+` FROM exchanges WHERE id=?`, id).Scan(&ref); errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("exchange not found")
	} else if err != nil {
		return nil, err
	}
	if !ref.Valid || len(ref.String) != 64 {
		return nil, errors.New("body not captured")
	}
	f, err := os.Open(filepath.Join(s.blobDir, ref.String[:2], ref.String))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("captured body is no longer available")
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, truncated, err := readLimited(f, limit)
	if err != nil {
		return nil, err
	}
	return map[string]any{"exchange_id": id, "side": side, "body_ref": ref.String, "encoding": "base64", "data": base64.StdEncoding.EncodeToString(data), "bytes": len(data), "truncated": truncated}, nil
}
