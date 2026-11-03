package blobs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPutAndRead(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sum, size, err := s.Put(strings.NewReader("hello"), 100)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte("hello"))
	if sum != hex.EncodeToString(want[:]) || size != 5 {
		t.Fatalf("Put = %s, %d", sum, size)
	}
	if _, err := os.Stat(filepath.Join(dir, sum[:2], sum)); err != nil {
		t.Fatalf("blob not at expected path: %v", err)
	}
	got, err := s.ReadAll(sum)
	if err != nil || string(got) != "hello" {
		t.Fatalf("ReadAll = %q, %v", got, err)
	}

	// Identical content is stored once and leaves no temp files behind.
	if again, _, err := s.Put(strings.NewReader("hello"), 100); err != nil || again != sum {
		t.Fatalf("second Put = %s, %v", again, err)
	}
	tmp, _ := os.ReadDir(filepath.Join(dir, "tmp"))
	if len(tmp) != 0 {
		t.Fatalf("%d temp files left", len(tmp))
	}

	if err := s.Delete(sum); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(sum); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Open after Delete: %v", err)
	}
	if err := s.Delete(sum); err != nil {
		t.Fatalf("deleting a missing blob: %v", err)
	}
}

func TestPutTooLarge(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if _, _, err := s.Put(strings.NewReader("123456"), 5); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Put over limit: %v", err)
	}
	if _, _, err := s.Put(strings.NewReader("12345"), 5); err != nil {
		t.Fatalf("Put at limit: %v", err)
	}
	tmp, _ := os.ReadDir(filepath.Join(dir, "tmp"))
	if len(tmp) != 0 {
		t.Fatalf("%d temp files left after a rejected Put", len(tmp))
	}
}

func TestRejectsBadHashes(t *testing.T) {
	s, _ := Open(t.TempDir())
	for _, sum := range []string{"", "../../etc/passwd", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if _, err := s.Open(sum); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("Open(%q) = %v, want an invalid-hash error", sum, err)
		}
	}
}
