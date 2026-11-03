// Package config loads and validates etherd's TOML configuration.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the contents of etherd.toml.
type Config struct {
	Domain  string `toml:"domain"`
	Listen  string `toml:"listen"`
	DataDir string `toml:"data_dir"`
	// Timezone is how the website and emails show times (an IANA name).
	Timezone      string `toml:"timezone"`
	BackupDir     string `toml:"backup_dir"`
	BackupKeep    int    `toml:"backup_keep"`
	Pepper        string `toml:"pepper"`
	PdftotextPath string `toml:"pdftotext_path"`
	Mail          Mail   `toml:"mail"`
	Limits        Limits `toml:"limits"`
	Dev           Dev    `toml:"dev,omitempty"`

	pepper []byte

	// Path is the file this was loaded from (not a setting).
	Path string `toml:"-"`
}

// Dev enables a fixed bearer token for local testing before OAuth exists
// (Phase 2). It is accepted only from the local machine, never through the
// tunnel, and is removed in Phase 4.
type Dev struct {
	Token   string `toml:"token"`
	Account string `toml:"account"`
	// BaseURL overrides https://<domain> as the OAuth issuer, so the full
	// OAuth flow can be tried locally, e.g. "http://127.0.0.1:18080".
	BaseURL string `toml:"base_url"`
}

// Enabled reports whether the development token is configured.
func (d Dev) Enabled() bool { return d.Token != "" }

// Mail configures the transactional email provider.
//
// Provider is "resend" to send through Resend's API, "log" to write messages
// to the server log instead (local testing only), or empty to disable sign-in.
type Mail struct {
	Provider string `toml:"provider"`
	APIKey   string `toml:"api_key"`
	From     string `toml:"from"`
}

// Sender returns the From address, defaulting to no-reply at the domain.
func (c *Config) Sender() string {
	if c.Mail.From != "" {
		return c.Mail.From
	}
	return "Etherchat <no-reply@" + c.Domain + ">"
}

// Limits holds the per-ether and per-account limits.
type Limits struct {
	MaxMembers          int      `toml:"max_members"`
	MaxFilesPerEther    int      `toml:"max_files_per_ether"`
	MaxEtherBytes       int64    `toml:"max_ether_bytes"`
	MaxVersionsPerFile  int      `toml:"max_versions_per_file"`
	MaxPostBytes        int      `toml:"max_post_bytes"`
	MaxEthersPerAccount int      `toml:"max_ethers_per_account"`
	InviteTTL           Duration `toml:"invite_ttl"`
	MaxScheduleAhead    Duration `toml:"max_schedule_ahead"`
}

// Duration is a time.Duration that reads from TOML strings like "168h".
type Duration struct{ time.Duration }

// UnmarshalText implements encoding.TextUnmarshaler.
func (d *Duration) UnmarshalText(b []byte) error {
	v, err := time.ParseDuration(string(b))
	if err != nil {
		return err
	}
	d.Duration = v
	return nil
}

// MarshalText implements encoding.TextMarshaler.
func (d Duration) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

// DefaultLimits returns the defaults.
func DefaultLimits() Limits {
	return Limits{
		MaxMembers:          4,
		MaxFilesPerEther:    2000,
		MaxEtherBytes:       1 << 30,
		MaxVersionsPerFile:  50,
		MaxPostBytes:        32 << 10,
		MaxEthersPerAccount: 20,
		InviteTTL:           Duration{7 * 24 * time.Hour},
		MaxScheduleAhead:    Duration{30 * 24 * time.Hour},
	}
}

// Default returns a config with every optional setting filled in.
func Default() Config {
	return Config{
		Listen:        "127.0.0.1:8080",
		Timezone:      "America/New_York",
		BackupKeep:    14,
		PdftotextPath: "pdftotext",
		Limits:        DefaultLimits(),
	}
}

// Load reads path, applies defaults for anything unset, and validates the result.
func Load(path string) (*Config, error) {
	c := Default()
	md, err := toml.DecodeFile(path, &c)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		return nil, fmt.Errorf("config %s: unknown setting %q", path, undecoded[0].String())
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	if c.Path, err = filepath.Abs(path); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) validate() error {
	if _, err := time.LoadLocation(c.Timezone); err != nil || c.Timezone == "" {
		return fmt.Errorf("timezone %q isn't a known time zone, like America/New_York", c.Timezone)
	}
	if c.DataDir == "" {
		return errors.New("data_dir is required")
	}
	if !filepath.IsAbs(c.DataDir) {
		return errors.New("data_dir must be an absolute path")
	}
	p, err := base64.StdEncoding.DecodeString(c.Pepper)
	if err != nil || len(p) < 32 {
		return errors.New("pepper must be at least 32 random bytes, base64-encoded")
	}
	c.pepper = p
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("listen must be a loopback address; the server is reachable only through the tunnel")
	}
	switch c.Mail.Provider {
	case "", "log":
	case "resend":
		if c.Mail.APIKey == "" {
			return errors.New("mail.api_key is required for provider resend")
		}
		if c.Mail.From == "" && c.Domain == "" {
			return errors.New("mail.from or domain is required to send email")
		}
	default:
		return fmt.Errorf("mail.provider must be resend, log, or empty, not %q", c.Mail.Provider)
	}
	if c.Dev.BaseURL != "" {
		u, err := url.Parse(c.Dev.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			return errors.New("dev.base_url must be a scheme and host, like http://127.0.0.1:18080")
		}
	}
	if c.Dev.Enabled() || c.Dev.Account != "" {
		if len(c.Dev.Token) < 32 || c.Dev.Account == "" {
			return errors.New("dev.token (at least 32 characters) and dev.account must be set together")
		}
	}
	if c.BackupKeep < 1 {
		return errors.New("backup_keep must be at least 1")
	}
	if c.BackupDir != "" && !filepath.IsAbs(c.BackupDir) {
		return errors.New("backup_dir must be an absolute path")
	}
	l := c.Limits
	switch {
	case l.MaxMembers < 1:
		return errors.New("limits.max_members must be at least 1")
	case l.MaxFilesPerEther < 1, l.MaxEtherBytes < 1, l.MaxVersionsPerFile < 1,
		l.MaxPostBytes < 1, l.MaxEthersPerAccount < 1:
		return errors.New("limits must be positive")
	case l.InviteTTL.Duration <= 0, l.MaxScheduleAhead.Duration <= 0:
		return errors.New("limits durations must be positive")
	}
	return nil
}

// PepperBytes returns the decoded server pepper used to HMAC login and invite codes.
func (c *Config) PepperBytes() []byte { return c.pepper }

// DBPath is the SQLite database location inside DataDir.
func (c *Config) DBPath() string { return filepath.Join(c.DataDir, "etherchat.db") }

// BackupPath is where backups go: backup_dir, or "backups" beside DataDir.
func (c *Config) BackupPath() string {
	if c.BackupDir != "" {
		return c.BackupDir
	}
	return filepath.Join(filepath.Dir(c.DataDir), "backups")
}

// BlobDir is the blob store location inside DataDir.
func (c *Config) BlobDir() string { return filepath.Join(c.DataDir, "blobs") }

// WriteNew writes a fresh config file for dataDir with a random pepper.
// It refuses to overwrite an existing file and creates it with mode 0600.
func WriteNew(path, dataDir, domain string) error {
	if !filepath.IsAbs(dataDir) {
		return errors.New("data dir must be an absolute path")
	}
	pepper := make([]byte, 32)
	if _, err := rand.Read(pepper); err != nil {
		return err
	}
	c := Default()
	c.Domain = domain
	c.DataDir = dataDir
	c.Pepper = base64.StdEncoding.EncodeToString(pepper)

	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := toml.NewEncoder(f).Encode(c); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// BaseURL is the public origin: the OAuth issuer and the MCP resource's
// scheme and host.
// Location is Timezone, loaded. validate has already checked it.
func (c *Config) Location() *time.Location {
	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

func (c *Config) BaseURL() string {
	if c.Dev.BaseURL != "" {
		return strings.TrimRight(c.Dev.BaseURL, "/")
	}
	return "https://" + c.Domain
}

// SetMail rewrites the config file at path with new mail settings, keeping
// everything else. The file is replaced atomically and stays mode 0600.
func SetMail(path string, m Mail) error {
	c, err := Load(path)
	if err != nil {
		return err
	}
	c.Mail = m
	if err := c.validate(); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".etherd-*.toml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := toml.NewEncoder(tmp).Encode(c); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
