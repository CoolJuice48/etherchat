package ether

import (
	"strings"
	"testing"
)

func TestParsePath(t *testing.T) {
	ok := []struct{ in, want string }{
		{"shared/plan.md", "shared/plan.md"},
		{"shared/notes/", "shared/notes"},
		{"members/alex/Week 3 notes.md", "members/alex/Week 3 notes.md"},
		{"members/alex/a/b/c/d/e/f.md", "members/alex/a/b/c/d/e/f.md"},
		{"shared", "shared"},
	}
	for _, c := range ok {
		p, err := ParsePath(c.in)
		if err != nil {
			t.Errorf("ParsePath(%q): %v", c.in, err)
			continue
		}
		if p.String() != c.want {
			t.Errorf("ParsePath(%q) = %q, want %q", c.in, p, c.want)
		}
	}

	bad := []string{
		"",
		"/shared/plan.md",
		"notes/plan.md",
		"shared/../members/x.md",
		"shared//plan.md",
		"shared/.hidden.md",
		"shared/ space.md",
		"shared/trailing /x.md",
		"shared/semi;colon.md",
		"shared/ünicode.md",
		"members/alex/a/b/c/d/e/f/g.md",
		"shared/" + strings.Repeat("a", 260) + ".md",
	}
	for _, in := range bad {
		if _, err := ParsePath(in); err == nil {
			t.Errorf("ParsePath(%q) succeeded, want error", in)
		}
	}
}

func TestPathParts(t *testing.T) {
	p, _ := ParsePath("members/alex/notes/plan.md")
	if p.Zone() != ZoneWorkspace || p.WorkspaceHandle() != "alex" || p.IsRoot() {
		t.Errorf("workspace path parts wrong: zone=%v handle=%q root=%v", p.Zone(), p.WorkspaceHandle(), p.IsRoot())
	}
	for _, root := range []string{"members", "members/alex", "shared"} {
		if r, _ := ParsePath(root); !r.IsRoot() {
			t.Errorf("%s should be a root", root)
		}
	}
	if s, _ := ParsePath("shared/plan.md"); s.Zone() != ZoneShared || s.WorkspaceHandle() != "" {
		t.Errorf("shared path parts wrong")
	}
}

func TestHandles(t *testing.T) {
	derive := map[string]string{
		"alex.morgan@example.com":                "alex.morgan",
		"Alex+ether@example.com":                 "alex-ether",
		"_x_@example.com":                        "x",
		"...@example.com":                        "user",
		strings.Repeat("a", 40) + "@example.com": strings.Repeat("a", 28),
	}
	for email, want := range derive {
		if got := deriveHandle(email); got != want {
			t.Errorf("deriveHandle(%q) = %q, want %q", email, got, want)
		}
		if !ValidHandle(deriveHandle(email)) {
			t.Errorf("deriveHandle(%q) produced an invalid handle", email)
		}
	}
	for _, h := range []string{"", "-alex", "alex-", "Alex", "ja ck", strings.Repeat("a", 33)} {
		if ValidHandle(h) {
			t.Errorf("ValidHandle(%q) = true", h)
		}
	}
}

func TestNormalizeCode(t *testing.T) {
	if got := normalizeCode(" abcd-efgh-ijkl-mn0p "); got != "ABCDEFGHIJKLMNOP" {
		t.Errorf("normalizeCode = %q", got)
	}
	code := newInviteCode()
	if len(code) != 19 || strings.Count(code, "-") != 3 {
		t.Errorf("newInviteCode() = %q, want XXXX-XXXX-XXXX-XXXX", code)
	}
}
