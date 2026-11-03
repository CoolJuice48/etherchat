package ether

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CoolJuice48/etherchat/go/adapters/blobs"
	"github.com/CoolJuice48/etherchat/go/adapters/store"
	"github.com/CoolJuice48/etherchat/go/run/config"
)

type fixture struct {
	t     *testing.T
	ctx   context.Context
	svc   *Service
	db    *store.DB
	clock time.Time
}

func newFixture(t *testing.T, tweak func(*config.Limits)) *fixture {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(ctx, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	bs, err := blobs.Open(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	limits := config.DefaultLimits()
	if tweak != nil {
		tweak(&limits)
	}
	f := &fixture{t: t, ctx: ctx, db: db, clock: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	f.svc = New(db, bs, limits, []byte(strings.Repeat("p", 32)))
	f.svc.SetClock(func() time.Time { return f.clock })
	return f
}

func (f *fixture) advance(d time.Duration) { f.clock = f.clock.Add(d) }

// account allowlists email and returns an actor for it.
func (f *fixture) account(email string) Actor {
	f.t.Helper()
	if err := f.svc.Allow(f.ctx, email, ""); err != nil {
		f.t.Fatal(err)
	}
	a, err := f.svc.EnsureAccount(f.ctx, email, true)
	if err != nil {
		f.t.Fatal(err)
	}
	return Actor{AccountID: a.ID, ClientID: "test"}
}

// join invites b into etherID (as inviter) and redeems the code.
func (f *fixture) join(inviter, b Actor, etherID, email string) {
	f.t.Helper()
	code, _, err := f.svc.CreateInvite(f.ctx, inviter, etherID, email)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.svc.JoinWithCode(f.ctx, b, code); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) write(a Actor, etherID, path, content string, expected int64, mode *Mode) (*WriteResult, error) {
	return f.svc.WriteFile(f.ctx, a, etherID, path, []byte(content), expected, mode)
}

func (f *fixture) mustWrite(a Actor, etherID, path, content string, expected int64, mode *Mode) *WriteResult {
	f.t.Helper()
	res, err := f.write(a, etherID, path, content, expected, mode)
	if err != nil {
		f.t.Fatalf("write %s: %v", path, err)
	}
	return res
}

func modePtr(m Mode) *Mode { return &m }

// trio sets up an ether owned by alice with bob as a member and carol outside.
func trio(t *testing.T, tweak func(*config.Limits)) (f *fixture, alice, bob, carol Actor, etherID string) {
	f = newFixture(t, tweak)
	alice = f.account("alice@example.com")
	bob = f.account("bob@example.com")
	carol = f.account("carol@example.com")
	e, err := f.svc.CreateEther(f.ctx, alice, "Atlas")
	if err != nil {
		t.Fatal(err)
	}
	f.join(alice, bob, e.ID, "bob@example.com")
	return f, alice, bob, carol, e.ID
}

func TestCreateEtherLayout(t *testing.T) {
	f, alice, bob, _, id := trio(t, nil)
	e, err := f.svc.GetEther(f.ctx, bob, id)
	if err != nil {
		t.Fatal(err)
	}
	if e.OwnerHandle != "alice" || len(e.Members) != 2 || !e.Members[0].Owner {
		t.Fatalf("unexpected ether: %+v", e)
	}
	entries, err := f.svc.ListFiles(f.ctx, alice, id, "", true)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, fi := range entries {
		paths = append(paths, fi.Path)
	}
	want := "members members/alice members/bob shared"
	if got := strings.Join(paths, " "); got != want {
		t.Errorf("tree = %q, want %q", got, want)
	}
}

// TestPermissionsEndToEnd exercises the §6 matrix through the service, so
// target construction and the checks in each operation are covered too.
func TestPermissionsEndToEnd(t *testing.T) {
	f, alice, bob, carol, id := trio(t, nil)

	f.mustWrite(alice, id, "members/alice/notes.md", "alice's notes", 0, nil)
	f.mustWrite(alice, id, "shared/plan.md", "the plan", 0, nil)                        // author_only
	f.mustWrite(bob, id, "shared/scratch.md", "scratch", 0, modePtr(ModeSharedEdit))    // shared_edit by bob
	f.mustWrite(bob, id, "shared/bob-only.md", "bob only", 0, nil)                      // author_only by bob
	f.mustWrite(bob, id, "shared/owner-may-delete.md", "x", 0, modePtr(ModeSharedEdit)) // shared_edit by bob

	type step struct {
		name string
		do   func() error
		want error // nil for success
	}
	steps := []step{
		{"bob reads alice's workspace", func() error {
			_, err := f.svc.ReadFile(f.ctx, bob, id, "members/alice/notes.md", 0)
			return err
		}, nil},
		{"bob writes into alice's workspace", func() error {
			_, err := f.write(bob, id, "members/alice/new.md", "x", 0, nil)
			return err
		}, ErrForbidden},
		{"bob edits alice's workspace file", func() error {
			_, err := f.write(bob, id, "members/alice/notes.md", "x", 1, nil)
			return err
		}, ErrForbidden},
		{"alice edits bob's author_only shared file", func() error {
			_, err := f.write(alice, id, "shared/bob-only.md", "x", 1, nil)
			return err
		}, ErrForbidden},
		{"alice edits bob's shared_edit file", func() error {
			_, err := f.write(alice, id, "shared/scratch.md", "edited by alice", 1, nil)
			return err
		}, nil},
		{"bob edits alice's author_only shared file", func() error {
			_, err := f.write(bob, id, "shared/plan.md", "x", 1, nil)
			return err
		}, ErrForbidden},
		{"alice (owner) deletes bob's author_only shared file", func() error {
			return f.svc.DeleteFile(f.ctx, alice, id, "shared/bob-only.md", 1)
		}, ErrForbidden},
		{"alice (owner) deletes bob's shared_edit file", func() error {
			return f.svc.DeleteFile(f.ctx, alice, id, "shared/owner-may-delete.md", 1)
		}, nil},
		{"bob deletes alice's workspace file", func() error {
			return f.svc.DeleteFile(f.ctx, bob, id, "members/alice/notes.md", 1)
		}, ErrForbidden},
		{"bob changes the mode of alice's file", func() error {
			return f.svc.SetMode(f.ctx, bob, id, "shared/plan.md", ModeSharedEdit)
		}, ErrForbidden},
		{"alice (owner) changes the mode of bob's shared_edit file", func() error {
			return f.svc.SetMode(f.ctx, alice, id, "shared/scratch.md", ModeAuthorOnly)
		}, nil},
		{"alice can no longer edit it", func() error {
			_, err := f.write(alice, id, "shared/scratch.md", "x", 2, nil)
			return err
		}, ErrForbidden},
		{"bob tries to make a file shared_edit in his workspace", func() error {
			_, err := f.write(bob, id, "members/bob/x.md", "x", 0, modePtr(ModeSharedEdit))
			return err
		}, ErrInvalid},
		{"bob deletes the shared/ root", func() error {
			return f.svc.DeleteFile(f.ctx, bob, id, "shared", 0)
		}, ErrForbidden},
		{"alice deletes her workspace root", func() error {
			return f.svc.DeleteFile(f.ctx, alice, id, "members/alice", 0)
		}, ErrForbidden},
		{"bob creates a folder in alice's workspace", func() error {
			_, err := f.svc.CreateFolder(f.ctx, bob, id, "members/alice/sub")
			return err
		}, ErrForbidden},
		{"carol (non-member) reads", func() error {
			_, err := f.svc.ReadFile(f.ctx, carol, id, "shared/plan.md", 0)
			return err
		}, ErrNotFound},
		{"carol (non-member) lists", func() error {
			_, err := f.svc.ListFiles(f.ctx, carol, id, "", true)
			return err
		}, ErrNotFound},
		{"carol (non-member) writes", func() error {
			_, err := f.write(carol, id, "shared/c.md", "x", 0, nil)
			return err
		}, ErrNotFound},
		{"unknown ether", func() error {
			_, err := f.svc.GetEther(f.ctx, alice, "nosuchether")
			return err
		}, ErrNotFound},
	}
	for _, s := range steps {
		err := s.do()
		switch {
		case s.want == nil && err != nil:
			t.Errorf("%s: unexpected error %v", s.name, err)
		case s.want != nil && !errors.Is(err, s.want):
			t.Errorf("%s: got %v, want %v", s.name, err, s.want)
		}
	}
}

func TestVersionConflicts(t *testing.T) {
	f, alice, bob, _, id := trio(t, nil)
	scratch := modePtr(ModeSharedEdit)

	r := f.mustWrite(alice, id, "shared/doc.md", "v1", 0, scratch)
	if r.Version != 1 || !r.Created {
		t.Fatalf("first write = %+v", r)
	}

	// Creating again with expected 0 conflicts and reports the current head.
	_, err := f.write(bob, id, "shared/doc.md", "other v1", 0, nil)
	var ce *ConflictError
	if !errors.As(err, &ce) || ce.Current != 1 || ce.CurrentAuthor != "alice" {
		t.Fatalf("create over existing: %v", err)
	}

	f.mustWrite(bob, id, "shared/doc.md", "v2 by bob", 1, nil)

	// Alice still thinks it's version 1.
	if _, err := f.write(alice, id, "shared/doc.md", "stale", 1, nil); !errors.As(err, &ce) || ce.Current != 2 || ce.CurrentAuthor != "bob" {
		t.Fatalf("stale write: %v", err)
	}
	// Editing a file that doesn't exist yet with expected > 0 conflicts with current 0.
	if _, err := f.write(alice, id, "shared/missing.md", "x", 3, nil); !errors.As(err, &ce) || ce.Current != 0 {
		t.Fatalf("expected>0 on missing file: %v", err)
	}
	// Stale delete.
	if err := f.svc.DeleteFile(f.ctx, alice, id, "shared/doc.md", 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale delete: %v", err)
	}

	got, err := f.svc.ReadFile(f.ctx, alice, id, "shared/doc.md", 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Content) != "v2 by bob" || got.Version != 2 || got.Author != "alice" || got.UpdatedBy != "bob" {
		t.Fatalf("read back %+v / %q", got.FileInfo, got.Content)
	}
	old, err := f.svc.ReadFile(f.ctx, bob, id, "shared/doc.md", 1)
	if err != nil || string(old.Content) != "v1" {
		t.Fatalf("read v1: %v %q", err, old.Content)
	}
}

// TestConcurrentWriters races two writers on the same expected version:
// exactly one must win and the other must get a conflict.
func TestConcurrentWriters(t *testing.T) {
	f, alice, bob, _, id := trio(t, nil)
	f.mustWrite(alice, id, "shared/race.md", "v1", 0, modePtr(ModeSharedEdit))

	for round := int64(1); round <= 20; round++ {
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, who := range []Actor{alice, bob} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, errs[i] = f.write(who, id, "shared/race.md", "round", round, nil)
			}()
		}
		wg.Wait()
		wins, conflicts := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrConflict):
				conflicts++
			default:
				t.Fatalf("round %d: unexpected error %v", round, err)
			}
		}
		if wins != 1 || conflicts != 1 {
			t.Fatalf("round %d: %d wins, %d conflicts", round, wins, conflicts)
		}
	}
	hist, err := f.svc.FileHistory(f.ctx, alice, id, "shared/race.md")
	if err != nil {
		t.Fatal(err)
	}
	if hist[0].Version != 21 {
		t.Fatalf("head = %d, want 21", hist[0].Version)
	}
}

func TestDeleteAndRecreate(t *testing.T) {
	f, alice, _, _, id := trio(t, nil)
	f.mustWrite(alice, id, "members/alice/tmp.md", "x", 0, nil)
	if err := f.svc.DeleteFile(f.ctx, alice, id, "members/alice/tmp.md", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadFile(f.ctx, alice, id, "members/alice/tmp.md", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read deleted: %v", err)
	}
	r := f.mustWrite(alice, id, "members/alice/tmp.md", "again", 0, nil)
	if r.Version != 1 || !r.Created {
		t.Fatalf("recreate = %+v", r)
	}

	if _, err := f.svc.CreateFolder(f.ctx, alice, id, "members/alice/dir/sub"); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteFile(f.ctx, alice, id, "members/alice/dir", 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete non-empty folder: %v", err)
	}
	if err := f.svc.DeleteFile(f.ctx, alice, id, "members/alice/dir/sub", 0); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteFile(f.ctx, alice, id, "members/alice/dir", 0); err != nil {
		t.Fatal(err)
	}
}

func TestPathsAreCaseInsensitive(t *testing.T) {
	f, alice, _, _, id := trio(t, nil)
	f.mustWrite(alice, id, "shared/Notes.md", "x", 0, nil)
	if _, err := f.write(alice, id, "shared/notes.md", "y", 0, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("case-different create: %v", err)
	}
	// A differently cased workspace segment lands under the stored spelling.
	r := f.mustWrite(alice, id, "members/ALICE/todo.md", "x", 0, nil)
	if r.Path != "members/alice/todo.md" {
		t.Fatalf("stored path = %q", r.Path)
	}
}

func TestFileTypes(t *testing.T) {
	f, alice, _, _, id := trio(t, nil)
	if _, err := f.write(alice, id, "shared/x.pdf", "x", 0, nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("pdf in phase 1: %v", err)
	}
	if _, err := f.write(alice, id, "shared/x.md", "bad\x00byte", 0, nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("NUL byte: %v", err)
	}
	if _, err := f.write(alice, id, "shared/x.md", string([]byte{0xff, 0xfe}), 0, nil); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid UTF-8: %v", err)
	}
	if _, err := f.write(alice, id, "shared/big.md", strings.Repeat("a", 256<<10+1), 0, nil); !errors.Is(err, ErrLimit) {
		t.Errorf("oversize: %v", err)
	}
	f.mustWrite(alice, id, "shared/ok.txt", "plain text", 0, nil)
}

func TestHistoryPruning(t *testing.T) {
	f, alice, _, _, id := trio(t, func(l *config.Limits) { l.MaxVersionsPerFile = 3 })
	for v := int64(0); v < 5; v++ {
		f.mustWrite(alice, id, "members/alice/log.md", "version "+string(rune('1'+v)), v, nil)
	}
	hist, err := f.svc.FileHistory(f.ctx, alice, id, "members/alice/log.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(hist) != 3 || hist[0].Version != 5 || hist[2].Version != 3 {
		t.Fatalf("history after pruning: %+v", hist)
	}
	if _, err := f.svc.ReadFile(f.ctx, alice, id, "members/alice/log.md", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read pruned version: %v", err)
	}
	var unreferenced int
	if err := f.db.Read().QueryRow(`SELECT COUNT(*) FROM blobs WHERE unreferenced_since IS NOT NULL`).Scan(&unreferenced); err != nil {
		t.Fatal(err)
	}
	if unreferenced != 2 {
		t.Fatalf("unreferenced blobs = %d, want 2", unreferenced)
	}
}

func TestLimits(t *testing.T) {
	f, alice, _, _, id := trio(t, func(l *config.Limits) {
		l.MaxFilesPerEther = 6 // 4 system folders + 2
		l.MaxEtherBytes = 20
		l.MaxEthersPerAccount = 2
	})
	f.mustWrite(alice, id, "shared/a.md", "0123456789", 0, nil)
	if _, err := f.write(alice, id, "shared/b.md", "0123456789x", 0, nil); !errors.Is(err, ErrLimit) {
		t.Errorf("storage limit: %v", err)
	}
	f.mustWrite(alice, id, "shared/b.md", "1", 0, nil)
	if _, err := f.write(alice, id, "shared/c.md", "1", 0, nil); !errors.Is(err, ErrLimit) {
		t.Errorf("entry limit: %v", err)
	}
	if _, err := f.svc.CreateEther(f.ctx, alice, "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateEther(f.ctx, alice, "third"); !errors.Is(err, ErrLimit) {
		t.Errorf("ethers per account: %v", err)
	}
}

func TestInvites(t *testing.T) {
	f := newFixture(t, nil)
	owner := f.account("owner@example.com")
	m1 := f.account("m1@example.com")
	m2 := f.account("m2@example.com")
	m3 := f.account("m3@example.com")
	m4 := f.account("m4@example.com")
	e, err := f.svc.CreateEther(f.ctx, owner, "Team")
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "stranger@example.com"); !errors.Is(err, ErrNotAllowlisted) {
		t.Fatalf("invite non-allowlisted: %v", err)
	}

	c1, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m1@example.com")
	if err != nil {
		t.Fatal(err)
	}
	// The code is bound to m1's email: m2 can't use it.
	if _, err := f.svc.JoinWithCode(f.ctx, m2, c1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong account redeems: %v", err)
	}
	// Lowercase, without dashes, still works.
	if _, err := f.svc.JoinWithCode(f.ctx, m1, strings.ToLower(strings.ReplaceAll(c1, "-", ""))); err != nil {
		t.Fatalf("join: %v", err)
	}
	if _, err := f.svc.JoinWithCode(f.ctx, m1, c1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reuse: %v", err)
	}
	if _, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m1@example.com"); !errors.Is(err, ErrExists) {
		t.Fatalf("invite existing member: %v", err)
	}

	// Members (2) + pending invites count toward the limit of 4.
	if _, _, err := f.svc.CreateInvite(f.ctx, m1, e.ID, "m2@example.com"); err != nil {
		t.Fatal(err)
	}
	c3, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m3@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m4@example.com"); !errors.Is(err, ErrLimit) {
		t.Fatalf("over limit: %v", err)
	}
	// Re-inviting the same address replaces the pending invite instead of adding one.
	c3b, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m3@example.com")
	if err != nil {
		t.Fatalf("re-invite: %v", err)
	}
	if _, err := f.svc.JoinWithCode(f.ctx, m3, c3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replaced code still works: %v", err)
	}

	pending, err := f.svc.PendingInvitesFor(f.ctx, m3)
	if err != nil || len(pending) != 1 || pending[0].EtherName != "Team" || pending[0].InvitedByHandle != "owner" {
		t.Fatalf("pending for m3: %+v %v", pending, err)
	}
	// Looking at an invite doesn't use it, and only its own address can look.
	for range 2 {
		inv, err := f.svc.InviteByCode(f.ctx, m3, c3b)
		if err != nil || inv.EtherName != "Team" || !strings.HasPrefix(inv.InvitedByEmail, "owner@") {
			t.Fatalf("invite by code: %+v %v", inv, err)
		}
	}
	if _, err := f.svc.InviteByCode(f.ctx, m4, c3b); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another address sees the invite: %v", err)
	}
	if err := f.svc.DeclineInvite(f.ctx, m4, c3b); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another address declines the invite: %v", err)
	}

	// Expired codes don't work, and stop counting toward the limit.
	f.advance(8 * 24 * time.Hour)
	if _, err := f.svc.JoinWithCode(f.ctx, m3, c3b); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired: %v", err)
	}
	c4, _, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m4@example.com")
	if err != nil {
		t.Fatalf("invite after expiry: %v", err)
	}
	if _, err := f.svc.JoinWithCode(f.ctx, m4, c4); err != nil {
		t.Fatal(err)
	}

	// Only the owner revokes.
	_, inv, err := f.svc.CreateInvite(f.ctx, owner, e.ID, "m2@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.RevokeInvite(f.ctx, m1, e.ID, inv.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member revokes: %v", err)
	}
	if err := f.svc.RevokeInvite(f.ctx, owner, e.ID, inv.ID); err != nil {
		t.Fatal(err)
	}
}

func TestMembership(t *testing.T) {
	f, alice, bob, _, id := trio(t, nil)
	f.mustWrite(bob, id, "members/bob/notes.md", "bob was here", 0, nil)

	if err := f.svc.LeaveEther(f.ctx, alice, id); !errors.Is(err, ErrForbidden) {
		t.Fatalf("owner leaves: %v", err)
	}
	if err := f.svc.RemoveMember(f.ctx, bob, id, "alice"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member removes owner: %v", err)
	}
	if err := f.svc.RemoveMember(f.ctx, alice, id, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadFile(f.ctx, bob, id, "shared", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member still reads: %v", err)
	}
	// The removed member's workspace stays readable as history.
	if got, err := f.svc.ReadFile(f.ctx, alice, id, "members/bob/notes.md", 0); err != nil || string(got.Content) != "bob was here" {
		t.Fatalf("history of removed member: %v", err)
	}
	// Bob can be invited back and finds his workspace intact.
	f.join(alice, bob, id, "bob@example.com")
	if _, err := f.svc.ReadFile(f.ctx, bob, id, "members/bob/notes.md", 0); err != nil {
		t.Fatalf("rejoined member: %v", err)
	}

	if err := f.svc.RenameEther(f.ctx, bob, id, "Mine now"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member renames: %v", err)
	}
	if err := f.svc.DeleteEther(f.ctx, alice, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.GetEther(f.ctx, alice, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted ether still visible: %v", err)
	}
	list, err := f.svc.ListEthers(f.ctx, bob)
	if err != nil || len(list) != 0 {
		t.Fatalf("bob's ethers after delete: %+v %v", list, err)
	}
}

func TestAllowlistAndAccounts(t *testing.T) {
	f := newFixture(t, nil)
	if _, err := f.svc.EnsureAccount(f.ctx, "nobody@example.com", true); !errors.Is(err, ErrNotAllowlisted) {
		t.Fatalf("non-allowlisted account: %v", err)
	}
	a := f.account("Alex@Example.com")
	acct, err := f.svc.AccountByID(f.ctx, a.AccountID)
	if err != nil || acct.Email != "alex@example.com" || acct.Handle != "alex" || !acct.Verified {
		t.Fatalf("account: %+v %v", acct, err)
	}
	// Same local part at another domain gets a numbered handle.
	b := f.account("alex@other.example")
	if acct, _ := f.svc.AccountByID(f.ctx, b.AccountID); acct.Handle != "alex2" {
		t.Fatalf("second alex handle = %q", acct.Handle)
	}

	// Handles change only before joining an ether.
	if err := f.svc.SetHandle(f.ctx, b.AccountID, "alex"); !errors.Is(err, ErrExists) {
		t.Fatalf("taken handle: %v", err)
	}
	if err := f.svc.SetHandle(f.ctx, b.AccountID, "jt"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateEther(f.ctx, b, "x"); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.SetHandle(f.ctx, b.AccountID, "jt2"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("handle change after joining: %v", err)
	}

	// Disallowing disables the account; re-allowing re-enables it.
	if err := f.svc.Disallow(f.ctx, "alex@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateEther(f.ctx, a, "y"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled account acts: %v", err)
	}
	if _, err := f.svc.EnsureAccount(f.ctx, "alex@example.com", true); !errors.Is(err, ErrNotAllowlisted) {
		t.Fatalf("sign-in after disallow: %v", err)
	}
	if err := f.svc.Allow(f.ctx, "alex@example.com", "back"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateEther(f.ctx, a, "y"); err != nil {
		t.Fatalf("re-allowed account: %v", err)
	}

	if _, err := NormalizeEmail("Alex <alex@example.com>"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("display-name address accepted: %v", err)
	}
}

func TestBoard(t *testing.T) {
	f, alice, bob, _, id := trio(t, nil)
	start := f.clock

	p1, err := f.svc.PostMessage(f.ctx, alice, id, PostInput{Intent: IntentUpdate, Title: "Monday", Body: "Did the schema."})
	if err != nil {
		t.Fatal(err)
	}
	if p1.PublishedAt == nil {
		t.Fatal("immediate post not published")
	}
	if _, err := f.svc.PostMessage(f.ctx, bob, id, PostInput{Intent: "chitchat", Body: "x"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad intent: %v", err)
	}
	if _, err := f.svc.PostMessage(f.ctx, bob, id, PostInput{Intent: IntentFYI, Body: "  "}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty body: %v", err)
	}

	f.advance(time.Minute)
	sendAt := f.clock.Add(4 * time.Hour)
	sched, err := f.svc.PostMessage(f.ctx, bob, id, PostInput{Intent: IntentHandoff, Body: "4pm update", SendAt: &sendAt})
	if err != nil {
		t.Fatal(err)
	}
	if sched.PublishedAt != nil {
		t.Fatal("scheduled post published early")
	}
	// Bob's reply-less scheduled post isn't on the board yet.
	posts, err := f.svc.ReadBoard(f.ctx, alice, id, time.Time{}, 0)
	if err != nil || len(posts) != 1 {
		t.Fatalf("board before publish: %d posts, %v", len(posts), err)
	}
	if mine, _ := f.svc.ListScheduled(f.ctx, bob, id); len(mine) != 1 {
		t.Fatalf("bob's scheduled posts: %d", len(mine))
	}

	f.advance(5 * time.Hour)
	if n, err := f.svc.PublishDue(f.ctx); err != nil || n != 1 {
		t.Fatalf("PublishDue = %d, %v", n, err)
	}
	// A reader who caught up just before publish still sees it: the post is
	// stamped with the publish time, not the scheduled time.
	posts, err = f.svc.ReadBoard(f.ctx, alice, id, start.Add(2*time.Hour), 0)
	if err != nil || len(posts) != 1 || posts[0].ID != sched.ID || posts[0].Author != "bob" {
		t.Fatalf("catch-up read: %+v %v", posts, err)
	}

	reply, err := f.svc.PostMessage(f.ctx, alice, id, PostInput{Intent: IntentReview, Body: "Looks good", ReplyTo: sched.ID})
	if err != nil || reply.ReplyTo != sched.ID {
		t.Fatalf("reply: %+v %v", reply, err)
	}
	if err := f.svc.CancelPost(f.ctx, bob, id, reply.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cancel someone else's post: %v", err)
	}
	if err := f.svc.CancelPost(f.ctx, alice, id, reply.ID); err != nil {
		t.Fatal(err)
	}

	// A scheduled post whose author left the ether is cancelled, not published.
	later := f.clock.Add(time.Hour)
	if _, err := f.svc.PostMessage(f.ctx, bob, id, PostInput{Intent: IntentFYI, Body: "bye", SendAt: &later}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.LeaveEther(f.ctx, bob, id); err != nil {
		t.Fatal(err)
	}
	f.advance(2 * time.Hour)
	if n, err := f.svc.PublishDue(f.ctx); err != nil || n != 0 {
		t.Fatalf("PublishDue after author left = %d, %v", n, err)
	}

	tooFar := f.clock.Add(31 * 24 * time.Hour)
	if _, err := f.svc.PostMessage(f.ctx, alice, id, PostInput{Intent: IntentFYI, Body: "x", SendAt: &tooFar}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("schedule too far ahead: %v", err)
	}
}
