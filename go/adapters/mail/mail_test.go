package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResendRequest(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		w.Write([]byte(`{"id":"abc"}`))
	}))
	defer srv.Close()

	r := &Resend{APIKey: "re_test", From: "Etherchat <no-reply@etherchat.example>", Endpoint: srv.URL}
	if err := r.Send(context.Background(), Message{To: "a@example.com", Subject: "Hi", Text: "Body"}); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer re_test" || got["from"] != "Etherchat <no-reply@etherchat.example>" ||
		got["subject"] != "Hi" || got["text"] != "Body" {
		t.Fatalf("request: auth=%q body=%v", auth, got)
	}
	if to, _ := got["to"].([]any); len(to) != 1 || to[0] != "a@example.com" {
		t.Fatalf("to = %v", got["to"])
	}
}

func TestResendError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"domain not verified"}`, http.StatusForbidden)
	}))
	defer srv.Close()
	err := (&Resend{APIKey: "k", From: "x@y.z", Endpoint: srv.URL}).Send(context.Background(), Message{To: "a@b.c"})
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "domain not verified") {
		t.Fatalf("err = %v", err)
	}
}

func TestDisabled(t *testing.T) {
	if err := New("", "", "", nil).Send(context.Background(), Message{}); err != ErrDisabled {
		t.Fatalf("err = %v", err)
	}
}
