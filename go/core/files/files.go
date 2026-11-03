// Package files decides which file types an ether accepts and validates content.
//
// Phase 1 accepts only the text category. Data, document and
// image categories are added in Phase 7 by extending the registry below.
package files

import (
	"bytes"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

// Category groups types that share size limits and handling.
type Category string

const (
	Text Category = "text"
)

// Type describes one accepted file extension.
type Type struct {
	Ext      string
	MIME     string
	Category Category
	MaxBytes int64
	// Textual types can be written directly by an agent with write_file.
	Textual bool
}

var registry = map[string]Type{
	".md":  {Ext: ".md", MIME: "text/markdown; charset=utf-8", Category: Text, MaxBytes: 256 << 10, Textual: true},
	".txt": {Ext: ".txt", MIME: "text/plain; charset=utf-8", Category: Text, MaxBytes: 256 << 10, Textual: true},
}

// ErrUnsupportedType means the extension is not on the allowed list.
var ErrUnsupportedType = errors.New("file type not allowed")

// ErrInvalidContent means the bytes don't match what the extension promises.
var ErrInvalidContent = errors.New("file content does not match its type")

// ErrTooLarge means the content exceeds the type's size limit.
var ErrTooLarge = errors.New("file too large for its type")

// Lookup returns the type for a file name, by extension (case-insensitive).
func Lookup(name string) (Type, error) {
	ext := strings.ToLower(path.Ext(name))
	t, ok := registry[ext]
	if !ok {
		return Type{}, fmt.Errorf("%w: %q", ErrUnsupportedType, ext)
	}
	return t, nil
}

// Validate checks that content is acceptable for a file named name and
// returns its type.
func Validate(name string, content []byte) (Type, error) {
	t, err := Lookup(name)
	if err != nil {
		return Type{}, err
	}
	if int64(len(content)) > t.MaxBytes {
		return Type{}, fmt.Errorf("%w: %d bytes, limit %d", ErrTooLarge, len(content), t.MaxBytes)
	}
	if t.Textual {
		if !utf8.Valid(content) {
			return Type{}, fmt.Errorf("%w: not valid UTF-8", ErrInvalidContent)
		}
		if bytes.IndexByte(content, 0) >= 0 {
			return Type{}, fmt.Errorf("%w: contains NUL bytes", ErrInvalidContent)
		}
	}
	return t, nil
}

// Extensions lists the accepted extensions, for error messages and tool descriptions.
func Extensions() []string {
	out := make([]string, 0, len(registry))
	for ext := range registry {
		out = append(out, ext)
	}
	sort.Strings(out)
	return out
}
