package files

import (
	"errors"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    error
	}{
		{"notes.md", "# hi", nil},
		{"NOTES.MD", "# hi", nil},
		{"plain.txt", "hello", nil},
		{"empty.md", "", nil},
		{"report.pdf", "%PDF", ErrUnsupportedType},
		{"page.html", "<p>", ErrUnsupportedType},
		{"noext", "x", ErrUnsupportedType},
		{"bad.md", "a\x00b", ErrInvalidContent},
		{"bad.md", string([]byte{0xc3, 0x28}), ErrInvalidContent},
		{"big.md", strings.Repeat("x", 256<<10+1), ErrTooLarge},
	}
	for _, c := range cases {
		typ, err := Validate(c.name, []byte(c.content))
		if c.want == nil {
			if err != nil {
				t.Errorf("Validate(%q): %v", c.name, err)
			} else if !strings.HasPrefix(typ.MIME, "text/") {
				t.Errorf("Validate(%q) MIME = %q", c.name, typ.MIME)
			}
			continue
		}
		if !errors.Is(err, c.want) {
			t.Errorf("Validate(%q) = %v, want %v", c.name, err, c.want)
		}
	}
}
