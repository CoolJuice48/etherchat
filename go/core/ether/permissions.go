package ether

// Mode is a shared file's write mode.
type Mode string

const (
	ModeAuthorOnly Mode = "author_only"
	ModeSharedEdit Mode = "shared_edit"
)

// ParseMode validates a mode string.
func ParseMode(s string) (Mode, error) {
	switch Mode(s) {
	case ModeAuthorOnly, ModeSharedEdit:
		return Mode(s), nil
	}
	return "", invalid("mode must be %q or %q", ModeAuthorOnly, ModeSharedEdit)
}

// Op is an action on a file or folder.
type Op int

const (
	OpRead Op = iota
	OpCreate
	OpEdit
	OpDelete
	OpChangeMode
)

func (o Op) String() string {
	return [...]string{"read", "create", "edit", "delete", "change mode"}[o]
}

// Target describes a file or folder from the acting member's point of view.
// Membership is checked before Allowed is consulted: non-members get
// ErrNotFound and never reach this.
type Target struct {
	Zone         Zone
	OwnWorkspace bool // the workspace belongs to the actor (ZoneWorkspace)
	IsAuthor     bool // the actor created the node (ZoneShared)
	IsOwner      bool // the actor owns the ether
	Mode         Mode // the node's mode (ZoneShared, existing nodes)
}

// Allowed is the permission matrix:
//
//	                 own workspace  other workspace  shared author_only  shared shared_edit
//	read             yes            yes              yes                 yes
//	create           yes            no               yes                 n/a
//	edit             yes            no               author              any member
//	delete           yes            no               author              author or owner
//	change mode      n/a            no               author              author or owner
func Allowed(op Op, t Target) bool {
	if op == OpRead {
		return true
	}
	switch t.Zone {
	case ZoneWorkspace:
		return t.OwnWorkspace && op != OpChangeMode
	case ZoneShared:
		switch op {
		case OpCreate:
			return true
		case OpEdit:
			return t.IsAuthor || t.Mode == ModeSharedEdit
		case OpDelete, OpChangeMode:
			return t.IsAuthor || (t.IsOwner && t.Mode == ModeSharedEdit)
		}
	}
	return false
}
