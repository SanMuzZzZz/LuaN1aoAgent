package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const flowFormat = "luanniao-flow-v1"

type epochSnapshot struct {
	Active   bool   `json:"active"`
	EpochRef string `json:"epochRef"`
	FlowFile string `json:"flowFile"`
}

type captureEpochStatus struct {
	ActiveFlowCount int    `json:"activeFlowCount"`
	ActiveTCPCount  int    `json:"activeTcpCount"`
	Persisted       int    `json:"persistedSequence"`
	Error           string `json:"error"`
}

type captureStatusFile struct {
	Ready  bool                          `json:"ready"`
	Epochs map[string]captureEpochStatus `json:"epochs"`
}

type captureWriter struct {
	epochPath    string
	statusPath   string
	mu           sync.Mutex
	statuses     map[string]captureEpochStatus
	segments     map[string]*captureSegments
	segmentBytes int64
	maxFiles     int
}

type captureLease struct {
	writer   *captureWriter
	epochRef string
	flowFile string
	once     sync.Once
}

type tcpCaptureLease struct {
	writer   *captureWriter
	epochRef string
	once     sync.Once
}

type capturedHTTPFlow struct {
	Format                string      `json:"format"`
	ID                    string      `json:"id"`
	FlowID                string      `json:"flow_id"`
	TaskRef               string      `json:"task_ref"`
	RunRef                string      `json:"run_ref"`
	EpochRef              string      `json:"epoch_ref"`
	RouteRef              string      `json:"route_ref"`
	ConnectionRef         string      `json:"connection_ref"`
	SessionRef            string      `json:"session_ref"`
	ReplayOf              string      `json:"replay_of"`
	Attribution           string      `json:"attribution"`
	RuntimeRef            string      `json:"runtime_ref"`
	StartedAt             string      `json:"started_at"`
	CompletedAt           string      `json:"completed_at"`
	DurationMS            int64       `json:"duration_ms"`
	Error                 string      `json:"error"`
	Kind                  string      `json:"kind"`
	Method                string      `json:"method"`
	URL                   string      `json:"url"`
	Host                  string      `json:"host"`
	Scheme                string      `json:"scheme"`
	Protocol              string      `json:"protocol"`
	Mode                  string      `json:"mode"`
	Status                int         `json:"status"`
	RequestBody           string      `json:"request_body_base64"`
	ResponseBody          string      `json:"response_body_base64"`
	RequestHeaders        [][2]string `json:"request_headers"`
	ResponseHeaders       [][2]string `json:"response_headers"`
	RequestTruncated      bool        `json:"request_truncated"`
	ResponseTruncated     bool        `json:"response_truncated"`
	RequestObservedBytes  int64       `json:"request_observed_bytes"`
	ResponseObservedBytes int64       `json:"response_observed_bytes"`
	SourceFile            string      `json:"source_file"`
	QuotaPressure         bool        `json:"quota_pressure"`
	EvictedExchanges      int         `json:"evicted_exchanges"`
}

func newCaptureWriter(epochPath, statusPath string) (*captureWriter, error) {
	segmentBytes, err := positiveEnvironmentInt64("LUANNIAO_MITM_SEGMENT_BYTES", 64<<20)
	if err != nil {
		return nil, err
	}
	maxFilesValue, err := positiveEnvironmentInt64("LUANNIAO_CAPTURE_MAX_FILES", 8)
	if err != nil {
		return nil, err
	}
	writer := &captureWriter{
		epochPath: epochPath, statusPath: statusPath,
		statuses: make(map[string]captureEpochStatus), segments: make(map[string]*captureSegments),
		segmentBytes: segmentBytes, maxFiles: int(maxFilesValue),
	}
	if err := writer.writeStatusLocked(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (writer *captureWriter) begin() (*captureLease, error) {
	epoch, err := writer.currentEpoch()
	if err != nil {
		return nil, err
	}
	if !epoch.Active || epoch.EpochRef == "" || epoch.FlowFile == "" {
		return &captureLease{}, nil
	}
	writer.mu.Lock()
	status := writer.statuses[epoch.EpochRef]
	status.ActiveFlowCount++
	writer.statuses[epoch.EpochRef] = status
	err = writer.writeStatusLocked()
	writer.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &captureLease{writer: writer, epochRef: epoch.EpochRef, flowFile: epoch.FlowFile}, nil
}

func (writer *captureWriter) beginTCP() (*tcpCaptureLease, error) {
	epoch, err := writer.currentEpoch()
	if err != nil {
		return nil, err
	}
	if !epoch.Active || epoch.EpochRef == "" {
		return &tcpCaptureLease{}, nil
	}
	writer.mu.Lock()
	previous := writer.statuses[epoch.EpochRef]
	status := previous
	status.ActiveTCPCount++
	writer.statuses[epoch.EpochRef] = status
	err = writer.writeStatusLocked()
	if err != nil {
		writer.statuses[epoch.EpochRef] = previous
	}
	writer.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &tcpCaptureLease{writer: writer, epochRef: epoch.EpochRef}, nil
}

func (writer *captureWriter) currentEpoch() (epochSnapshot, error) {
	payload, err := os.ReadFile(writer.epochPath)
	if err != nil {
		return epochSnapshot{}, fmt.Errorf("read capture epoch: %w", err)
	}
	var epoch epochSnapshot
	if err := json.Unmarshal(payload, &epoch); err != nil {
		return epochSnapshot{}, fmt.Errorf("decode capture epoch: %w", err)
	}
	return epoch, nil
}

func (lease *tcpCaptureLease) finish() error {
	if lease.writer == nil || lease.epochRef == "" {
		return nil
	}
	var result error
	lease.once.Do(func() {
		lease.writer.mu.Lock()
		defer lease.writer.mu.Unlock()
		status := lease.writer.statuses[lease.epochRef]
		if status.ActiveTCPCount > 0 {
			status.ActiveTCPCount--
		}
		lease.writer.statuses[lease.epochRef] = status
		result = lease.writer.writeStatusLocked()
	})
	return result
}

func (lease *captureLease) finish(flow *capturedHTTPFlow) error {
	if lease.writer == nil || lease.epochRef == "" {
		return nil
	}
	var result error
	lease.once.Do(func() {
		flow.Format = flowFormat
		flow.EpochRef = lease.epochRef
		flow.SourceFile = lease.flowFile
		payload, err := json.Marshal(flow)
		if err == nil {
			payload = append(payload, '\n')
		}
		lease.writer.mu.Lock()
		defer lease.writer.mu.Unlock()
		status := lease.writer.statuses[lease.epochRef]
		if err == nil {
			err = lease.writer.appendFlowLocked(lease.flowFile, payload)
		}
		if err != nil {
			status.Error = err.Error()
			result = err
		} else {
			status.Persisted++
		}
		if status.ActiveFlowCount > 0 {
			status.ActiveFlowCount--
		}
		lease.writer.statuses[lease.epochRef] = status
		if statusErr := lease.writer.writeStatusLocked(); result == nil {
			result = statusErr
		}
	})
	return result
}

func (writer *captureWriter) appendFlowLocked(path string, payload []byte) error {
	segments := writer.segments[path]
	if segments == nil {
		var err error
		segments, err = loadCaptureSegments(path, writer.segmentBytes, writer.maxFiles)
		if err != nil {
			return err
		}
		writer.segments[path] = segments
	}
	return segments.append(payload)
}

func (writer *captureWriter) writeStatusLocked() error {
	payload, err := json.Marshal(captureStatusFile{Ready: true, Epochs: writer.statuses})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(writer.statusPath), 0o755); err != nil {
		return fmt.Errorf("create capture status directory: %w", err)
	}
	return atomicWriteFile(writer.statusPath, payload, 0o664)
}

func appendAndSync(path string, payload []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o664)
	if err != nil {
		return fmt.Errorf("open capture file: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(payload); err != nil {
		return fmt.Errorf("append capture file: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync capture file: %w", err)
	}
	return nil
}

func newCapturedHTTPFlow(id, taskRef, runRef, routeRef, connectionRef, scheme, protocol string, started time.Time) *capturedHTTPFlow {
	return &capturedHTTPFlow{
		ID: id, FlowID: id, TaskRef: taskRef, RunRef: runRef,
		RouteRef: routeRef, ConnectionRef: connectionRef,
		StartedAt: started.UTC().Format(time.RFC3339Nano),
		Kind:      "http", Scheme: scheme, Protocol: protocol, Mode: "mitm",
	}
}

func (flow *capturedHTTPFlow) complete(started time.Time, requestBody, responseBody []byte) {
	completed := time.Now().UTC()
	flow.CompletedAt = completed.Format(time.RFC3339Nano)
	flow.DurationMS = completed.Sub(started).Milliseconds()
	flow.RequestBody = base64.StdEncoding.EncodeToString(requestBody)
	flow.ResponseBody = base64.StdEncoding.EncodeToString(responseBody)
}
