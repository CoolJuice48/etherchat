package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWriteNewThenLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "etherd.toml")
	if err := WriteNew(path, filepath.Join(dir, "data"), "etherchat.example"); err != nil {
		t.Fatal(err)
	}
	if err := WriteNew(path, filepath.Join(dir, "data"), ""); err == nil {
		t.Fatal("WriteNew overwrote an existing file")
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Domain != "etherchat.example" || len(c.PepperBytes()) != 32 || c.Limits.MaxMembers != 4 {
		t.Fatalf("loaded %+v", c)
	}
	if c.Limits.InviteTTL.Duration != 7*24*time.Hour {
		t.Fatalf("invite TTL = %v", c.Limits.InviteTTL)
	}
	if c.DBPath() != filepath.Join(dir, "data", "etherchat.db") {
		t.Fatalf("DBPath = %s", c.DBPath())
	}
}

func TestLoadValidation(t *testing.T) {
	const pepper = `pepper = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="` // 32 bytes
	cases := []struct {
		name, body, wantErr string
	}{
		{"missing data_dir", pepper, "data_dir is required"},
		{"relative data_dir", pepper + "\ndata_dir = \"data\"", "absolute"},
		{"short pepper", "data_dir = \"/x\"\npepper = \"c2hvcnQ=\"", "pepper"},
		{"unknown key", pepper + "\ndata_dir = \"/x\"\ndomian = \"typo.com\"", "unknown setting"},
		{"bad limit", pepper + "\ndata_dir = \"/x\"\n[limits]\nmax_members = 0", "max_members"},
		{"bad duration", pepper + "\ndata_dir = \"/x\"\n[limits]\ninvite_ttl = \"soon\"", "invalid duration"},
		{"overrides", pepper + "\ndata_dir = \"/x\"\n[limits]\nmax_members = 3\ninvite_ttl = \"48h\"", ""},
	}
	for _, c := range cases {
		path := filepath.Join(t.TempDir(), "etherd.toml")
		if err := os.WriteFile(path, []byte(c.body), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := Load(path)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%s: %v", c.name, err)
			} else if cfg.Limits.MaxMembers != 3 || cfg.Limits.InviteTTL.Duration != 48*time.Hour ||
				cfg.Limits.MaxFilesPerEther != 2000 {
				t.Errorf("%s: overrides not applied over defaults: %+v", c.name, cfg.Limits)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: got %v, want error containing %q", c.name, err, c.wantErr)
		}
	}
}

func TestSetMail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "etherd.toml")
	if err := WriteNew(path, filepath.Join(dir, "data"), "etherchat.example"); err != nil {
		t.Fatal(err)
	}
	before, _ := Load(path)
	if err := SetMail(path, Mail{Provider: "resend", APIKey: "re_test"}); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Mail.Provider != "resend" || c.Mail.APIKey != "re_test" || c.Pepper != before.Pepper || c.Domain != "etherchat.example" {
		t.Fatalf("after SetMail: %+v", c)
	}
	if c.Sender() != "Etherchat <no-reply@etherchat.example>" || c.BaseURL() != "https://etherchat.example" {
		t.Fatalf("sender %q base %q", c.Sender(), c.BaseURL())
	}
	st, _ := os.Stat(path)
	b, _ := os.ReadFile(path)
	if st.Mode().Perm() != 0o600 || strings.Contains(string(b), "[dev]") {
		t.Fatalf("mode %v, contents:\n%s", st.Mode(), b)
	}
	if err := SetMail(path, Mail{Provider: "resend"}); err == nil {
		t.Fatal("resend without a key was accepted")
	}
}

func TestTimezone(t *testing.T) {
	c := Default()
	if c.Timezone != "America/New_York" || c.Location().String() != "America/New_York" {
		t.Fatalf("default timezone: %q", c.Timezone)
	}
	c.Domain, c.DataDir, c.Pepper = "etherchat.example", "/tmp/x", strings.Repeat("p", 64)
	c.Timezone = "Eastern"
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "time zone") {
		t.Fatalf("bad timezone: %v", err)
	}
}
