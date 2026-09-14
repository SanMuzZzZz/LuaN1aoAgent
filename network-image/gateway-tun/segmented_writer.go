package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type captureSegments struct {
	path           string
	segmentBytes   int64
	maxFiles       int
	nextSequence   int
	activeRecords  int
	evictedRecords int
}

type capturePart struct {
	sequence int
	records  int
	path     string
}

type captureQuotaManifest struct {
	Version          int            `json:"version"`
	SegmentBytes     int64          `json:"segmentBytes"`
	MaxFiles         int            `json:"maxFiles"`
	QuotaBytes       int64          `json:"quotaBytes"`
	QuotaPressure    bool           `json:"quotaPressure"`
	EvictedRecords   int            `json:"evictedRecords"`
	EvictedExchanges int            `json:"evictedExchanges"`
	Evictions        map[string]int `json:"evictions"`
}

func positiveEnvironmentInt64(name string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func loadCaptureSegments(path string, segmentBytes int64, maxFiles int) (*captureSegments, error) {
	if !strings.HasSuffix(path, ".mitm") {
		return nil, fmt.Errorf("capture path must end with .mitm")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o770); err != nil {
		return nil, err
	}
	segments := &captureSegments{path: path, segmentBytes: segmentBytes, maxFiles: maxFiles, nextSequence: 1}
	segments.activeRecords = countJSONLines(path)
	manifest := segments.readManifest()
	segments.evictedRecords = manifest.EvictedExchanges
	parts := segments.parts()
	for _, part := range parts {
		if part.sequence >= segments.nextSequence {
			segments.nextSequence = part.sequence + 1
		}
	}
	if err := segments.enforceRetention(); err != nil {
		return nil, err
	}
	return segments, segments.writeManifest()
}

func (segments *captureSegments) append(payload []byte) error {
	details, err := os.Stat(segments.path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && details.Size() > 0 && details.Size()+int64(len(payload)) > segments.segmentBytes {
		if err := segments.rotate(); err != nil {
			return err
		}
	}
	if err := appendAndSync(segments.path, payload); err != nil {
		return err
	}
	segments.activeRecords++
	return nil
}

func (segments *captureSegments) rotate() error {
	target := fmt.Sprintf("%s.part-%06d-n%09d.mitm", strings.TrimSuffix(segments.path, ".mitm"), segments.nextSequence, segments.activeRecords)
	segments.nextSequence++
	if err := os.Rename(segments.path, target); err != nil {
		return err
	}
	segments.activeRecords = 0
	if err := segments.enforceRetention(); err != nil {
		return err
	}
	return segments.writeManifest()
}

func (segments *captureSegments) parts() []capturePart {
	base := regexp.QuoteMeta(filepath.Base(strings.TrimSuffix(segments.path, ".mitm")))
	pattern := regexp.MustCompile("^" + base + `\.part-(\d+)-n(\d+)\.mitm$`)
	paths, _ := filepath.Glob(strings.TrimSuffix(segments.path, ".mitm") + ".part-*-n*.mitm")
	parts := make([]capturePart, 0, len(paths))
	for _, path := range paths {
		match := pattern.FindStringSubmatch(filepath.Base(path))
		if len(match) != 3 {
			continue
		}
		sequence, _ := strconv.Atoi(match[1])
		records, _ := strconv.Atoi(match[2])
		parts = append(parts, capturePart{sequence: sequence, records: records, path: path})
	}
	sort.Slice(parts, func(left, right int) bool { return parts[left].sequence < parts[right].sequence })
	return parts
}

func (segments *captureSegments) enforceRetention() error {
	parts := segments.parts()
	retained := segments.maxFiles - 1
	if retained < 0 {
		retained = 0
	}
	for _, part := range parts[:max(0, len(parts)-retained)] {
		if err := os.Remove(part.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		segments.evictedRecords += part.records
	}
	return nil
}

func (segments *captureSegments) manifestPath() string { return segments.path + ".quota.json" }

func (segments *captureSegments) readManifest() captureQuotaManifest {
	payload, err := os.ReadFile(segments.manifestPath())
	if err != nil {
		return captureQuotaManifest{}
	}
	var value captureQuotaManifest
	_ = json.Unmarshal(payload, &value)
	return value
}

func (segments *captureSegments) writeManifest() error {
	value := captureQuotaManifest{
		Version: 1, SegmentBytes: segments.segmentBytes, MaxFiles: segments.maxFiles,
		QuotaBytes:     segments.segmentBytes * int64(segments.maxFiles),
		QuotaPressure:  segments.evictedRecords > 0,
		EvictedRecords: segments.evictedRecords, EvictedExchanges: segments.evictedRecords,
		Evictions: map[string]int{},
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWriteFile(segments.manifestPath(), payload, 0o664)
}

func countJSONLines(path string) int {
	file, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer file.Close()
	count := 0
	scanner := bufio.NewScanner(file)
	buffer := make([]byte, 64<<10)
	scanner.Buffer(buffer, 4<<20)
	for scanner.Scan() {
		count++
	}
	return count
}
