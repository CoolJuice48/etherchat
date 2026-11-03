package ether

import "testing"

// TestAllowedMatrix covers every cell of the permission matrix.
func TestAllowedMatrix(t *testing.T) {
	ownWS := Target{Zone: ZoneWorkspace, OwnWorkspace: true}
	otherWS := Target{Zone: ZoneWorkspace}
	otherWSAsOwner := Target{Zone: ZoneWorkspace, IsOwner: true}

	sharedAO := func(author, owner bool) Target {
		return Target{Zone: ZoneShared, IsAuthor: author, IsOwner: owner, Mode: ModeAuthorOnly}
	}
	sharedSE := func(author, owner bool) Target {
		return Target{Zone: ZoneShared, IsAuthor: author, IsOwner: owner, Mode: ModeSharedEdit}
	}
	newShared := Target{Zone: ZoneShared}

	cases := []struct {
		name string
		op   Op
		t    Target
		want bool
	}{
		// Read: every member, everywhere.
		{"read own workspace", OpRead, ownWS, true},
		{"read other workspace", OpRead, otherWS, true},
		{"read shared author_only, not author", OpRead, sharedAO(false, false), true},
		{"read shared shared_edit, not author", OpRead, sharedSE(false, false), true},

		// Create.
		{"create in own workspace", OpCreate, ownWS, true},
		{"create in other workspace", OpCreate, otherWS, false},
		{"create in other workspace as owner", OpCreate, otherWSAsOwner, false},
		{"create in shared", OpCreate, newShared, true},

		// Edit.
		{"edit own workspace", OpEdit, ownWS, true},
		{"edit other workspace", OpEdit, otherWS, false},
		{"edit other workspace as owner", OpEdit, otherWSAsOwner, false},
		{"edit shared author_only as author", OpEdit, sharedAO(true, false), true},
		{"edit shared author_only as member", OpEdit, sharedAO(false, false), false},
		{"edit shared author_only as owner", OpEdit, sharedAO(false, true), false},
		{"edit shared shared_edit as author", OpEdit, sharedSE(true, false), true},
		{"edit shared shared_edit as member", OpEdit, sharedSE(false, false), true},
		{"edit shared shared_edit as owner", OpEdit, sharedSE(false, true), true},

		// Delete.
		{"delete own workspace", OpDelete, ownWS, true},
		{"delete other workspace", OpDelete, otherWS, false},
		{"delete other workspace as owner", OpDelete, otherWSAsOwner, false},
		{"delete shared author_only as author", OpDelete, sharedAO(true, false), true},
		{"delete shared author_only as member", OpDelete, sharedAO(false, false), false},
		{"delete shared author_only as owner", OpDelete, sharedAO(false, true), false},
		{"delete shared shared_edit as author", OpDelete, sharedSE(true, false), true},
		{"delete shared shared_edit as member", OpDelete, sharedSE(false, false), false},
		{"delete shared shared_edit as owner", OpDelete, sharedSE(false, true), true},

		// Change mode.
		{"change mode in own workspace", OpChangeMode, ownWS, false},
		{"change mode in other workspace", OpChangeMode, otherWS, false},
		{"change mode shared author_only as author", OpChangeMode, sharedAO(true, false), true},
		{"change mode shared author_only as member", OpChangeMode, sharedAO(false, false), false},
		{"change mode shared author_only as owner", OpChangeMode, sharedAO(false, true), false},
		{"change mode shared shared_edit as author", OpChangeMode, sharedSE(true, false), true},
		{"change mode shared shared_edit as member", OpChangeMode, sharedSE(false, false), false},
		{"change mode shared shared_edit as owner", OpChangeMode, sharedSE(false, true), true},
	}
	for _, c := range cases {
		if got := Allowed(c.op, c.t); got != c.want {
			t.Errorf("%s: Allowed = %v, want %v", c.name, got, c.want)
		}
	}
}
