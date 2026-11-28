package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPHealthAndInvalidClip(t *testing.T) {
	handler := newHTTPHandler()
	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest("GET", "/health", nil))
	if health.Code != http.StatusOK || health.Body.String() != "ok" {
		t.Fatal(health)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/clip", strings.NewReader(`{"id":"bad"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatal(response.Code)
	}
}

func TestLocalLogSanitization(t *testing.T) {
	clean := cleanMessage("wss://user:pass@example.com/rtc?token=sensitive password=private Bearer hidden")
	for _, secret := range []string{"user:pass", "/rtc", "sensitive", "private", "hidden"} {
		if strings.Contains(clean, secret) {
			t.Fatal("credential retained in local log")
		}
	}
}

func TestClipSubprocessHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := clipCommandOutput(ctx, "ffprobe", "-version"); err == nil {
		t.Fatal("canceled subprocess succeeded")
	}
}
