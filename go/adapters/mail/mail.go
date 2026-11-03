// Package mail sends Etherchat's emails, sign-in codes and invites, with an
// HTML part and a plain-text part.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// Message is one email. HTML is optional; Text is always sent.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Mailer sends messages.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// ErrDisabled is returned by Send when no provider is configured.
var ErrDisabled = errors.New("email is not configured")

// New returns the mailer for provider ("resend", "log", or "" for none).
func New(provider, apiKey, from string, log *slog.Logger) Mailer {
	switch provider {
	case "resend":
		return &Resend{APIKey: apiKey, From: from}
	case "log":
		return &Log{Logger: log}
	}
	return Disabled{}
}

// Disabled refuses to send.
type Disabled struct{}

func (Disabled) Send(context.Context, Message) error { return ErrDisabled }

// Log writes messages to the server log instead of sending them. It exists
// for local testing: the log then contains sign-in codes, so never use it
// on a server other people sign in to.
type Log struct{ Logger *slog.Logger }

func (l *Log) Send(_ context.Context, m Message) error {
	l.Logger.Warn("email not sent (mail.provider = log)", "to", m.To, "subject", m.Subject, "text", m.Text)
	return nil
}

// Resend sends through Resend's HTTPS API.
type Resend struct {
	APIKey   string
	From     string
	Endpoint string       // defaults to https://api.resend.com/emails
	Client   *http.Client // defaults to a client with a 15-second timeout
}

func (r *Resend) Send(ctx context.Context, m Message) error {
	endpoint := r.Endpoint
	if endpoint == "" {
		endpoint = "https://api.resend.com/emails"
	}
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	payload := map[string]any{
		"from":    r.From,
		"to":      []string{m.To},
		"subject": m.Subject,
		"text":    m.Text,
	}
	if m.HTML != "" {
		payload["html"] = m.HTML
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("resend: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("resend: HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(detail))
	}
	return nil
}
