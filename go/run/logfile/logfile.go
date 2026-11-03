// Package logfile is a size-rotated log file. launchd opens a service's
// StandardOutPath once and never reopens it, so outside rotation (newsyslog)
// can't work without restarting etherd; etherd rotates its own log instead.
package logfile

import (
	"fmt"
	"os"
	"sync"
)

// File is an append-only log file that rotates at MaxBytes, keeping Keep
// old files as path.1 (newest) … path.Keep.
type File struct {
	Path     string
	MaxBytes int64
	Keep     int

	mu   sync.Mutex
	f    *os.File
	size int64
}

// Open opens (or creates, mode 0600) the log file at path.
func Open(path string, maxBytes int64, keep int) (*File, error) {
	l := &File{Path: path, MaxBytes: maxBytes, Keep: keep}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *File) open() error {
	f, err := os.OpenFile(l.Path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, st.Size()
	return nil
}

// Write appends p, rotating first if p would push the file past MaxBytes.
func (l *File) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size > 0 && l.size+int64(len(p)) > l.MaxBytes {
		if err := l.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

func (l *File) rotate() error {
	if err := l.f.Close(); err != nil {
		return err
	}
	for i := l.Keep - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", l.Path, i), fmt.Sprintf("%s.%d", l.Path, i+1))
	}
	if l.Keep > 0 {
		if err := os.Rename(l.Path, l.Path+".1"); err != nil {
			return err
		}
	} else if err := os.Remove(l.Path); err != nil {
		return err
	}
	return l.open()
}

// Close closes the file.
func (l *File) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}
