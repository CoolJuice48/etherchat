package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// cimdFetcher downloads Client ID Metadata Documents. The client_id URL comes
// from whoever starts an authorization, so the fetch is locked down: HTTPS
// only, no redirects, 5 seconds, 64 KB, and it refuses to connect to any
// address that isn't public. The address check happens at dial time, after
// DNS resolution, so a hostname can't be pointed at the home network.
type cimdFetcher struct {
	client  *http.Client
	maxSize int64
}

const cimdMaxSize = 64 << 10

func newCIMDFetcher() *cimdFetcher {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if !publicAddr(ip) {
					return nil, fmt.Errorf("refusing to fetch from non-public address %s", ip)
				}
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("no addresses for %s", host)
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
	}
	return &cimdFetcher{
		client: &http.Client{
			Transport:     transport,
			Timeout:       5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		maxSize: cimdMaxSize,
	}
}

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64 can map to private IPv4
	netip.MustParsePrefix("2001:db8::/32"),
}

// publicAddr reports whether ip is a routable public address.
func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// checkCIMDURL applies the Client ID Metadata Document URL rules: https, a
// host, a path, and no fragment, credentials, or dot segments.
func checkCIMDURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	switch {
	case u.Scheme != "https" || u.Host == "":
		return errors.New("client_id must be an https URL")
	case u.User != nil:
		return errors.New("client_id must not contain credentials")
	case u.Fragment != "" || strings.Contains(raw, "#"):
		return errors.New("client_id must not have a fragment")
	case u.Path == "" || u.Path == "/":
		return errors.New("client_id must have a path")
	}
	for _, seg := range strings.Split(u.Path, "/") {
		if seg == "." || seg == ".." {
			return errors.New("client_id must not contain dot segments")
		}
	}
	return nil
}

type cimdDocument struct {
	ClientID                string   `json:"client_id"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
}

// fetch downloads and validates a metadata document. v1 supports public
// clients only (token_endpoint_auth_method "none"); signed client
// assertions (private_key_jwt) come later.
func (f *cimdFetcher) fetch(ctx context.Context, clientID string) (*Client, []byte, error) {
	if err := checkCIMDURL(clientID); err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("metadata document returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, f.maxSize+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(body)) > f.maxSize {
		return nil, nil, fmt.Errorf("metadata document is larger than %d bytes", f.maxSize)
	}
	var doc cimdDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, nil, fmt.Errorf("metadata document is not JSON: %w", err)
	}
	if doc.ClientID != clientID {
		return nil, nil, errors.New("metadata document's client_id doesn't match its URL")
	}
	if len(doc.RedirectURIs) == 0 || len(doc.RedirectURIs) > 10 {
		return nil, nil, errors.New("metadata document needs 1 to 10 redirect_uris")
	}
	for _, u := range doc.RedirectURIs {
		if err := checkRedirectURI(u); err != nil {
			return nil, nil, fmt.Errorf("%w: %s", err, u)
		}
	}
	if m := doc.TokenEndpointAuthMethod; m != "" && m != "none" {
		return nil, nil, fmt.Errorf("token_endpoint_auth_method %q isn't supported yet; use none", m)
	}
	name := cleanName(doc.ClientName)
	if name == "" {
		name = req.URL.Host
	}
	return &Client{ID: clientID, Kind: "cimd", Name: name, RedirectURIs: doc.RedirectURIs, AuthMethod: "none"}, body, nil
}
