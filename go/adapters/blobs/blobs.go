// Package blobs is a content-addressed store for file contents.
//
// Each blob lives at <dir>/<first two hex chars>/<sha256> and never changes
// after it is written.
package blobs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ErrTooLarge is returned when content exceeds the size limit passed to Put.
var ErrTooLarge = errors.New("blob exceeds size limit")

// ErrNotFound is returned when no blob has the requested hash.
var ErrNotFound = errors.New("blob not found")

// Store is a directory of blobs.
type Store struct{ dir string }

// Open returns a store rooted at dir, creating it if needed.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

// Put writes r to the store and returns its SHA-256 (hex) and size.
// Reading stops with ErrTooLarge once more than maxBytes have arrived.
func (s *Store) Put(r io.Reader, maxBytes int64) (sum string, size int64, err error) {
	tmp, err := os.CreateTemp(filepath.Join(s.dir, "tmp"), "put-*")
	if err != nil {
		return "", 0, err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()

	h := sha256.New()
	size, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, maxBytes+1))
	if err != nil {
		return "", 0, err
	}
	if size > maxBytes {
		return "", 0, ErrTooLarge
	}
	if err = tmp.Sync(); err != nil {
		return "", 0, err
	}
	if err = tmp.Close(); err != nil {
		return "", 0, err
	}

	sum = hex.EncodeToString(h.Sum(nil))
	final := s.path(sum)
	if _, statErr := os.Stat(final); statErr == nil {
		os.Remove(tmp.Name())
		return sum, size, nil
	}
	if err = os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return "", 0, err
	}
	if err = os.Rename(tmp.Name(), final); err != nil {
		return "", 0, err
	}
	return sum, size, nil
}

// Open returns a reader for the blob with the given hash.
func (s *Store) Open(sum string) (io.ReadCloser, error) {
	if !validSum(sum) {
		return nil, fmt.Errorf("invalid blob hash %q", sum)
	}
	f, err := os.Open(s.path(sum))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

// ReadAll returns the whole blob.
func (s *Store) ReadAll(sum string) ([]byte, error) {
	f, err := s.Open(sum)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// Delete removes the blob. Deleting a missing blob is not an error.
func (s *Store) Delete(sum string) error {
	if !validSum(sum) {
		return fmt.Errorf("invalid blob hash %q", sum)
	}
	err := os.Remove(s.path(sum))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *Store) path(sum string) string {
	return filepath.Join(s.dir, sum[:2], sum)
}

// validSum accepts only the lowercase hex that Put produces, so a hash can
// never name a path outside the store.
func validSum(sum string) bool {
	if len(sum) != 64 {
		return false
	}
	for _, c := range sum {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Dir is the store's root directory.
func (s *Store) Dir() string { return s.dir }
