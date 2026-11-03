package ether

import "strings"

const (
	maxPathBytes = 255
	maxDepth     = 8

	rootMembers = "members"
	rootShared  = "shared"
)

// Zone is the part of an ether a path lives in.
type Zone int

const (
	ZoneWorkspace Zone = iota // members/<handle>/...
	ZoneShared                // shared/...
)

// Path is a validated path inside an ether, such as "shared/notes/plan.md".
type Path struct {
	segs []string
}

// ParsePath validates p against the path rules: it starts with members/ or
// shared/, segments use [A-Za-z0-9._ -] and don't start with '.' or with or
// end in a space, at most 8 levels and 255 bytes. One trailing '/' is ignored.
func ParsePath(p string) (Path, error) {
	if strings.HasPrefix(p, "/") {
		return Path{}, invalid("path %q must not start with '/'; paths start with members/ or shared/", p)
	}
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		return Path{}, invalid("path is empty")
	}
	if len(p) > maxPathBytes {
		return Path{}, invalid("path is longer than %d bytes", maxPathBytes)
	}
	segs := strings.Split(p, "/")
	if len(segs) > maxDepth {
		return Path{}, invalid("path %q is deeper than %d levels", p, maxDepth)
	}
	for _, s := range segs {
		if err := checkSegment(s); err != nil {
			return Path{}, invalid("path %q: %s", p, err)
		}
	}
	if segs[0] != rootMembers && segs[0] != rootShared {
		return Path{}, invalid("path %q must start with members/ or shared/", p)
	}
	return Path{segs: segs}, nil
}

type segmentError string

func (e segmentError) Error() string { return string(e) }

func checkSegment(s string) error {
	switch {
	case s == "":
		return segmentError("empty segment")
	case s[0] == '.':
		return segmentError("segments can't start with '.'")
	case s[0] == ' ' || s[len(s)-1] == ' ':
		return segmentError("segments can't start or end with a space")
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '.' || c == '_' || c == ' ' || c == '-'
		if !ok {
			return segmentError("only letters, digits, '.', '_', '-' and spaces are allowed")
		}
	}
	return nil
}

// String returns the canonical form.
func (p Path) String() string { return strings.Join(p.segs, "/") }

// Name is the last segment.
func (p Path) Name() string { return p.segs[len(p.segs)-1] }

// Depth is the number of segments.
func (p Path) Depth() int { return len(p.segs) }

// Zone reports whether the path is in a workspace or the shared tree.
func (p Path) Zone() Zone {
	if p.segs[0] == rootMembers {
		return ZoneWorkspace
	}
	return ZoneShared
}

// WorkspaceHandle is the handle of the workspace the path is in, or "" for
// shared paths and the bare "members" folder.
func (p Path) WorkspaceHandle() string {
	if p.segs[0] != rootMembers || len(p.segs) < 2 {
		return ""
	}
	return p.segs[1]
}

// IsRoot reports whether the path is "members", "shared" or a workspace root:
// the system folders every ether has.
func (p Path) IsRoot() bool {
	return len(p.segs) == 1 || (p.segs[0] == rootMembers && len(p.segs) == 2)
}

// Parent returns the parent path; ok is false for top-level paths.
func (p Path) Parent() (parent Path, ok bool) {
	if len(p.segs) == 1 {
		return Path{}, false
	}
	return Path{segs: p.segs[:len(p.segs)-1]}, true
}

// ancestors returns every proper ancestor, top first.
func (p Path) ancestors() []Path {
	out := make([]Path, 0, len(p.segs)-1)
	for i := 1; i < len(p.segs); i++ {
		out = append(out, Path{segs: p.segs[:i]})
	}
	return out
}

func workspacePath(handle string) string { return rootMembers + "/" + handle }
