package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var telemetryEnabled bool
var urlPattern = regexp.MustCompile(`https?://[^\s"'<>]+`)
var secretPattern = regexp.MustCompile(`(?i)\b(token|secret|password|code|cookie|authorization)=[^\s&,;]+`)
var bearerPattern = regexp.MustCompile(`(?i)Bearer\s+\S+`)

func cleanMessage(message string) string {
	message = urlPattern.ReplaceAllStringFunc(message, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return "[url]"
		}
		return u.Scheme + "://" + u.Host + u.EscapedPath()
	})
	message = secretPattern.ReplaceAllString(message, "$1=[redacted]")
	message = bearerPattern.ReplaceAllString(message, "Bearer [redacted]")
	if len(message) > 8192 {
		message = message[:8192]
	}
	return message
}

// Um handler comum sanitiza tanto o console quanto os logs OTLP.
type telemetryLogHandler struct {
	console  slog.Handler
	exporter slog.Handler
}

func (h telemetryLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.console.Enabled(ctx, level)
}
func (h telemetryLogHandler) Handle(ctx context.Context, record slog.Record) error {
	safe := slog.NewRecord(record.Time, record.Level, cleanMessage(record.Message), record.PC)
	record.Attrs(func(a slog.Attr) bool {
		if !strings.Contains(strings.ToLower(a.Key), "token") && !strings.Contains(strings.ToLower(a.Key), "secret") && !strings.Contains(strings.ToLower(a.Key), "password") && a.Key != "cookie" && a.Key != "authorization" {
			safe.AddAttrs(slog.String(a.Key, cleanMessage(a.Value.String())))
		}
		return true
	})
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		safe.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	_ = h.console.Handle(ctx, safe)
	if h.exporter != nil {
		return h.exporter.Handle(ctx, safe)
	}
	return nil
}
func (h telemetryLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	// Atributos vinculados passam pelo mesmo saneamento no Handle.
	return &boundLogHandler{handler: h, attrs: attrs}
}
func (h telemetryLogHandler) WithGroup(name string) slog.Handler { return h }

type boundLogHandler struct {
	handler telemetryLogHandler
	attrs   []slog.Attr
}

func (h *boundLogHandler) Enabled(c context.Context, l slog.Level) bool {
	return h.handler.Enabled(c, l)
}
func (h *boundLogHandler) Handle(c context.Context, r slog.Record) error {
	r = r.Clone()
	r.AddAttrs(h.attrs...)
	return h.handler.Handle(c, r)
}
func (h *boundLogHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return &boundLogHandler{h.handler, append(append([]slog.Attr{}, h.attrs...), a...)}
}
func (h *boundLogHandler) WithGroup(name string) slog.Handler { return h }

func initTelemetry(ctx context.Context) (func(context.Context) error, error) {
	console := slog.NewJSONHandler(os.Stdout, nil)
	slog.SetDefault(slog.New(telemetryLogHandler{console: console}))
	telemetryEnabled = os.Getenv("OTEL_ENABLED") == "true"
	if !telemetryEnabled {
		return func(context.Context) error { return nil }, nil
	}
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) { fmt.Fprintln(os.Stderr, "[telemetry] exportação indisponível") }))
	res := resource.NewSchemaless(attribute.String("service.name", env("OTEL_SERVICE_NAME", "fazol-recorder")), attribute.String("service.version", env("APP_VERSION", "development")), attribute.String("deployment.environment.name", env("OTEL_ENVIRONMENT", "production")))
	te, err := otlptracehttp.New(ctx, otlptracehttp.WithTimeout(time.Second), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}))
	if err != nil {
		return nil, err
	}
	me, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithTimeout(time.Second), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}))
	if err != nil {
		_ = te.Shutdown(ctx)
		return nil, err
	}
	le, err := otlploghttp.New(ctx, otlploghttp.WithTimeout(time.Second), otlploghttp.WithRetry(otlploghttp.RetryConfig{Enabled: false}))
	if err != nil {
		_ = te.Shutdown(ctx)
		_ = me.Shutdown(ctx)
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(te, sdktrace.WithMaxQueueSize(1024), sdktrace.WithMaxExportBatchSize(128), sdktrace.WithBatchTimeout(5*time.Second), sdktrace.WithExportTimeout(1500*time.Millisecond)))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(me, sdkmetric.WithInterval(15*time.Second), sdkmetric.WithTimeout(1500*time.Millisecond))))
	lp := sdklog.NewLoggerProvider(sdklog.WithResource(res), sdklog.WithProcessor(sdklog.NewBatchProcessor(le, sdklog.WithMaxQueueSize(1024), sdklog.WithExportMaxBatchSize(128), sdklog.WithExportInterval(5*time.Second), sdklog.WithExportTimeout(1500*time.Millisecond))))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	slog.SetDefault(slog.New(telemetryLogHandler{console: console, exporter: otelslog.NewHandler("fazol", otelslog.WithLoggerProvider(lp))}))
	meter := otel.Meter("fazol.recorder")
	memory, _ := meter.Int64ObservableGauge("process.memory.usage", metric.WithUnit("By"))
	goroutines, _ := meter.Int64ObservableGauge("go.goroutines")
	roomsGauge, _ := meter.Int64ObservableGauge("fazol.recorder.rooms.active")
	recordingsGauge, _ := meter.Int64ObservableGauge("fazol.recorder.recordings.active")
	_, _ = meter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		observer.ObserveInt64(memory, int64(stats.Sys))
		observer.ObserveInt64(goroutines, int64(runtime.NumGoroutine()))
		roomsMu.Lock()
		n := len(rooms)
		roomsMu.Unlock()
		observer.ObserveInt64(roomsGauge, int64(n))
		mu.Lock()
		list := make([]*recording, 0, len(records))
		for _, r := range records {
			list = append(list, r)
		}
		mu.Unlock()
		active := int64(0)
		for _, r := range list {
			r.mu.Lock()
			if r.cmd != nil {
				active++
			}
			r.mu.Unlock()
		}
		observer.ObserveInt64(recordingsGauge, active)
		return nil
	}, memory, goroutines, roomsGauge, recordingsGauge)
	return func(ctx context.Context) error {
		telemetryEnabled = false
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx), lp.Shutdown(ctx))
	}, nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}

func instrumentHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !telemetryEnabled || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		route := "unmatched"
		switch r.URL.Path {
		case "/clip", "/join":
			route = r.URL.Path
		}
		method := r.Method
		switch method {
		case "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS":
		default:
			method = "OTHER"
		}
		parent := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.Tracer("fazol.http").Start(parent, method+" "+route, trace.WithSpanKind(trace.SpanKindServer))
		started := time.Now()
		response := &statusWriter{ResponseWriter: w}
		defer func() {
			status := response.status
			if status == 0 {
				status = 200
			}
			attrs := []attribute.KeyValue{attribute.String("http.request.method", method), attribute.String("http.route", route), attribute.Int("http.response.status_code", status)}
			span.SetAttributes(attrs...)
			if status >= 500 {
				span.SetStatus(codes.Error, "")
			}
			span.End()
			meter := otel.Meter("fazol.http")
			counter, _ := meter.Int64Counter("http.server.request.count")
			duration, _ := meter.Float64Histogram("http.server.request.duration", metric.WithUnit("s"))
			counter.Add(ctx, 1, metric.WithAttributes(attrs...))
			duration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attrs...))
		}()
		next.ServeHTTP(response, r.WithContext(ctx))
	})
}

func clipObservation(ctx context.Context, started time.Time, err error) {
	result := "success"
	if err != nil {
		result = "error"
	}
	attrs := metric.WithAttributes(attribute.String("result", result))
	meter := otel.Meter("fazol.recorder")
	counter, _ := meter.Int64Counter("fazol.recorder.clips.count")
	duration, _ := meter.Float64Histogram("fazol.recorder.clip.duration", metric.WithUnit("s"))
	counter.Add(ctx, 1, attrs)
	duration.Record(ctx, time.Since(started).Seconds(), attrs)
}

func clipCommandOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, span := otel.Tracer("fazol.recorder").Start(ctx, "recorder."+name)
	defer span.End()
	command := exec.CommandContext(ctx, name, args...)
	var output []byte
	var err error
	if name == "ffprobe" {
		output, err = command.Output()
	} else {
		output, err = command.CombinedOutput()
	}
	if err != nil {
		span.SetStatus(codes.Error, "")
	}
	return output, err
}
