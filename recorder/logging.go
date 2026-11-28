package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var urlPattern = regexp.MustCompile(`(?i)(https?|wss?)://[^\s"'<>]+`)
var secretPattern = regexp.MustCompile(`(?i)(["']?(access_token|refresh_token|client_secret|state|token|secret|password|code|cookie|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}\]]+)`)
var headerPattern = regexp.MustCompile(`(?i)\b(cookie|set-cookie|authorization)\s*:[^\r\n]+`)
var queryPattern = regexp.MustCompile(`\?[^\s"'<>]*`)
var bearerPattern = regexp.MustCompile(`(?i)Bearer\s+\S+`)

func cleanMessage(message string) string {
	message = urlPattern.ReplaceAllStringFunc(message, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return "[url]"
		}
		return u.Scheme + "://" + u.Host
	})
	message = headerPattern.ReplaceAllString(message, "$1: [redacted]")
	message = secretPattern.ReplaceAllString(message, "${1}[redacted]")
	message = bearerPattern.ReplaceAllString(message, "Bearer [redacted]")
	message = queryPattern.ReplaceAllString(message, "?[redacted]")
	if len(message) > 8192 {
		message = message[:8192]
	}
	return message
}

// Um handler comum sanitiza os logs locais.
type localLogHandler struct {
	console slog.Handler
}

func (h localLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.console.Enabled(ctx, level)
}
func (h localLogHandler) Handle(ctx context.Context, record slog.Record) error {
	safe := slog.NewRecord(record.Time, record.Level, cleanMessage(record.Message), record.PC)
	record.Attrs(func(a slog.Attr) bool {
		key := strings.ToLower(a.Key)
		if err, ok := a.Value.Any().(error); ok {
			safe.AddAttrs(slog.String("error.type", fmt.Sprintf("%T", err)))
			return true
		}
		if !strings.Contains(key, "token") && !strings.Contains(key, "secret") && !strings.Contains(key, "password") && key != "cookie" && key != "authorization" && key != "state" {
			safe.AddAttrs(slog.String(a.Key, cleanMessage(a.Value.String())))
		}
		return true
	})
	_ = h.console.Handle(ctx, safe)
	return nil
}
func (h localLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	// Atributos vinculados passam pelo mesmo saneamento no Handle.
	return &boundLogHandler{handler: h, attrs: attrs}
}
func (h localLogHandler) WithGroup(name string) slog.Handler { return h }

type boundLogHandler struct {
	handler localLogHandler
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

func initLogging() {
	slog.SetDefault(slog.New(localLogHandler{console: slog.NewJSONHandler(os.Stdout, nil)}))
}

func clipCommandOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	var output []byte
	var err error
	if name == "ffprobe" {
		output, err = command.Output()
	} else {
		output, err = command.CombinedOutput()
	}
	return output, err
}
