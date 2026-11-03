package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAdminFlow is Phase 1's acceptance check: the admin CLI allowlists an
// email and creates an ether.
func TestAdminFlow(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "etherd.toml")

	run1 := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := run(ctx, args, &out); err != nil {
			t.Fatalf("etherd %s: %v", strings.Join(args, " "), err)
		}
		return out.String()
	}

	run1("init", "--config", cfg, "--data-dir", filepath.Join(dir, "data"), "--domain", "etherchat.example")
	if st, err := os.Stat(cfg); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("config file mode: %v %v", st.Mode(), err)
	}
	if err := run(ctx, []string{"init", "--config", cfg, "--data-dir", filepath.Join(dir, "data")}, &bytes.Buffer{}); err == nil {
		t.Fatal("init overwrote an existing config")
	}

	run1("admin", "--config", cfg, "allow", "--email", "Owner@Example.com", "--note", "me")
	if out := run1("admin", "--config", cfg, "list-allowed"); !strings.Contains(out, "owner@example.com") {
		t.Fatalf("list-allowed:\n%s", out)
	}
	out := run1("admin", "--config", cfg, "create-ether", "--owner", "owner@example.com", "--name", "Atlas")
	if !strings.Contains(out, `created ether "Atlas"`) || !strings.Contains(out, "@owner") {
		t.Fatalf("create-ether:\n%s", out)
	}
	if out := run1("admin", "--config", cfg, "list-ethers"); !strings.Contains(out, "Atlas") {
		t.Fatalf("list-ethers:\n%s", out)
	}
	if out := run1("admin", "--config", cfg, "list-accounts"); !strings.Contains(out, "@owner") {
		t.Fatalf("list-accounts:\n%s", out)
	}

	err := run(ctx, []string{"admin", "--config", cfg, "create-ether", "--owner", "stranger@example.com", "--name", "x"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("create-ether for a non-allowlisted owner: %v", err)
	}
	if err := run(ctx, []string{"admin", "--config", cfg, "allow"}, &bytes.Buffer{}); !errors.As(err, new(usageError)) {
		t.Fatalf("missing --email: %v", err)
	}
}
