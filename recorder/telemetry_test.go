package main

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectormetric "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestTelemetryPropagatesAndExportsWithoutSecrets(t *testing.T) {
	var mu sync.Mutex
	var spans collectortrace.ExportTraceServiceRequest
	var logs collectorlog.ExportLogsServiceRequest
	var metrics collectormetric.ExportMetricsServiceRequest
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/v1/traces":
			_ = proto.Unmarshal(data, &spans)
		case "/v1/logs":
			_ = proto.Unmarshal(data, &logs)
		case "/v1/metrics":
			_ = proto.Unmarshal(data, &metrics)
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	defer collector.Close()
	t.Setenv("OTEL_ENABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.URL)
	shutdown, err := initTelemetry(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	handler := instrumentHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slog.ErrorContext(r.Context(), "failed https://user:password@example.com/clip?token=url-secret", "token", "attribute-secret")
		slog.ErrorContext(r.Context(), "wss://user:ws-password@example.com/live?access_token=ws-secret")
		slog.ErrorContext(r.Context(), "/callback?access_token=relative-secret&state=state-secret")
		slog.ErrorContext(r.Context(), "Cookie: session=cookie-secret; other=other-secret")
		slog.ErrorContext(r.Context(), `{"client_secret":"json-secret","access_token":"json-token"}`)
		slog.ErrorContext(r.Context(), "upstream failed", "error", errors.New("opaque-upstream-secret"))
		_, _ = w.Write([]byte(trace.SpanContextFromContext(r.Context()).TraceID().String()))
	}))
	request := httptest.NewRequest("POST", "http://recorder/clip?room=private-room", nil)
	request.Header.Set("traceparent", "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Body.String() != "1234567890abcdef1234567890abcdef" {
		t.Fatal(response.Body.String())
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	clipRequest := httptest.NewRequest("POST", "/clip", strings.NewReader(`{"id":"clip123","seconds":30}`)).WithContext(canceled)
	clipResponse := httptest.NewRecorder()
	newHTTPHandler().ServeHTTP(clipResponse, clipRequest)
	if clipResponse.Code != 500 {
		t.Fatal(clipResponse.Code)
	}
	if _, err := clipCommandOutput(context.Background(), "fazol-missing-command"); err == nil {
		t.Fatal("comando ausente deveria falhar")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(spans.ResourceSpans) == 0 || len(metrics.ResourceMetrics) == 0 || len(logs.ResourceLogs) == 0 {
		t.Fatal("faltou exportar um sinal")
	}
	span := spans.ResourceSpans[0].ScopeSpans[0].Spans[0]
	if span.Name != "POST /clip" || hex.EncodeToString(span.TraceId) != "1234567890abcdef1234567890abcdef" {
		t.Fatal(span)
	}
	record := logs.ResourceLogs[0].ScopeLogs[0].LogRecords[0]
	if hex.EncodeToString(record.TraceId) != "1234567890abcdef1234567890abcdef" {
		t.Fatal("log sem trace")
	}
	encoded := protojson.Format(&spans) + protojson.Format(&logs) + protojson.Format(&metrics)
	for _, secret := range []string{"password", "url-secret", "attribute-secret", "private-room", "ws-password", "ws-secret", "relative-secret", "state-secret", "cookie-secret", "other-secret", "json-secret", "json-token", "opaque-upstream-secret"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("vazou %s", secret)
		}
	}
}

func TestCollectorUnavailableDoesNotBlockHTTP(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
	shutdown, err := initTelemetry(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	handler := instrumentHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	started := time.Now()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/clip", nil))
	if response.Code != 204 || time.Since(started) > time.Second {
		t.Fatal("collector bloqueou HTTP")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = shutdown(ctx)
	if time.Since(started) > 4*time.Second {
		t.Fatal("shutdown sem prazo")
	}
}

func TestTelemetryDisabledKeepsHTTPWorking(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "false")
	shutdown, err := initTelemetry(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer shutdown(context.Background())
	response := httptest.NewRecorder()
	newHTTPHandler().ServeHTTP(response, httptest.NewRequest("POST", "/clip", strings.NewReader(`{"id":"bad"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatal(response.Code)
	}
}
