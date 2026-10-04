// Package providerhttp bounds requests to trusted provider HTTPS origins.
// Callers still own fresh authorization, provider identity and lifecycle fences.
package providerhttp

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	MaxRequestBytes          = 16384
	MaxResponseBytes         = 65536
	MaxMetadataResponseBytes = 262144
	requestBudget            = 10 * time.Second
)

var (
	ErrUnavailable = errors.New("provider request unavailable")
	ErrBusy        = errors.New("provider request capacity unavailable")
	dnsLabel       = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	dnsTLD         = regexp.MustCompile(`^[a-z][a-z0-9-]*[a-z0-9]$`)
	basePath       = regexp.MustCompile(`^(/[A-Za-z0-9_-]+)*$`)
	requestPath    = regexp.MustCompile(`^/[A-Za-z0-9_./:-]*$`)
)

// Admission must be shared by all provider clients in one worker process.
// There is no queue or detached request; the slot covers response consumption.
type Admission struct{ slots chan struct{} }

func NewAdmission() *Admission { return &Admission{slots: make(chan struct{}, 2)} }

type resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type dial func(context.Context, string, string) (net.Conn, error)
type Client struct{ state *clientState }
type clientState struct {
	origin        *url.URL
	admission     *Admission
	http          *http.Client
	responseLimit int
}

func (c *Client) String() string             { return "<provider HTTPS client>" }
func (c *Client) Format(s fmt.State, _ rune) { _, _ = io.WriteString(s, c.String()) }

// New does not read ambient proxies, cookies, credentials or alternate hosts.
// The origin must come from trusted stored metadata, not a public URL input.
func New(origin string, admission *Admission) (*Client, error) {
	return NewWithResponseLimit(origin, admission, MaxResponseBytes)
}

// NewWithResponseLimit supports a separately reviewed metadata budget. Callers
// choose a compiled policy, never a user-supplied byte limit. Ordinary report and
// token clients stay at 64 KiB; large filtered catalog metadata may use 256 KiB.
// All other TLS/DNS/deadline/header/admission/privacy limits remain unchanged.
func NewWithResponseLimit(origin string, admission *Admission, limit int) (*Client, error) {
	if limit != MaxResponseBytes && limit != MaxMetadataResponseBytes {
		return nil, ErrUnavailable
	}
	d := &net.Dialer{Timeout: 2 * time.Second, KeepAlive: -1}
	c, err := newClient(origin, admission, net.DefaultResolver, d.DialContext, nil)
	if err != nil {
		return nil, err
	}
	c.state.responseLimit = limit
	return c, nil
}

// ValidOrigin checks canonical syntax without DNS lookup or network work. Every
// actual request still independently verifies public addresses and TLS identity.
func ValidOrigin(raw string) bool {
	_, err := parseOrigin(raw)
	return err == nil
}

func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 520 || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || u.Host != u.Hostname() || u.String() != raw || len(u.Host) > 253 || len(u.Path) > 256 || !basePath.MatchString(u.Path) {
		return nil, ErrUnavailable
	}
	labels := strings.Split(u.Host, ".")
	if len(labels) < 2 || !dnsTLD.MatchString(labels[len(labels)-1]) {
		return nil, ErrUnavailable
	}
	for _, label := range labels {
		if len(label) < 1 || len(label) > 63 || !dnsLabel.MatchString(label) {
			return nil, ErrUnavailable
		}
	}
	return u, nil
}

var forbidden = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
}
var ipv6Global = netip.MustParsePrefix("2000::/3")

// Conservative destination policy; it deliberately excludes special-use
// transition/translation ranges rather than claiming every global IP is safe.
func public(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || (addr.Is6() && !ipv6Global.Contains(addr)) {
		return false
	}
	for _, prefix := range forbidden {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func newClient(raw string, admission *Admission, resolve resolver, connect dial, roots *x509.CertPool) (*Client, error) {
	origin, err := parseOrigin(raw)
	if err != nil || admission == nil || admission.slots == nil || resolve == nil || connect == nil {
		return nil, ErrUnavailable
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots} // Package-private isolated test CA only.
	transport := &http.Transport{
		Proxy: nil, TLSClientConfig: tlsConfig, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 4 * time.Second,
		MaxResponseHeaderBytes: 16384, DisableCompression: true, DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil || host != origin.Host || port != "443" || network != "tcp" {
				return nil, ErrUnavailable
			}
			answers, err := resolve.LookupNetIP(ctx, "ip", host)
			if err != nil || len(answers) < 1 || len(answers) > 8 {
				return nil, ErrUnavailable
			}
			for _, answer := range answers {
				if !public(answer) {
					return nil, ErrUnavailable
				}
			}
			// Use validated IP literals, never re-resolve in the dialer. Each attempt
			// inherits the request budget; TLS still authenticates the original host.
			for _, answer := range answers {
				connection, err := connect(ctx, "tcp", net.JoinHostPort(answer.Unmap().String(), "443"))
				if err == nil && connection != nil {
					return connection, nil
				}
				if connection != nil {
					_ = connection.Close()
				}
				if ctx.Err() != nil {
					break
				}
			}
			return nil, ErrUnavailable
		},
	}
	return &Client{&clientState{origin, admission, &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, MaxResponseBytes}}, nil
}

var queryKeys = map[string]bool{
	"after": true, "before": true, "page": true, "per_page": true, "orderby": true, "order": true, "_fields": true,
	"dp": true, "dates_are_gmt": true, "include": true, "fields": true, "time_increment": true, "time_range": true,
	"level": true, "limit": true, "offset": true,
}

// Do accepts adapter-owned paths/query/header data, not arbitrary user URLs.
// Success returns only a bounded JSON body. All private HTTP errors/statuses,
// redirects, headers and partial data are discarded. No business retry occurs.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body []byte, authorization, contentType string) ([]byte, error) {
	return c.do(ctx, method, path, query, body, authorization, contentType, nil)
}

// PageResult carries only the compiled WooCommerce pagination headers and body.
// The caller clears the private body after complete schema interpretation.
type PageResult struct {
	Body              []byte
	Total, TotalPages string
}

func (p PageResult) String() string               { return "<provider collection page>" }
func (p PageResult) Format(s fmt.State, _ rune)   { _, _ = io.WriteString(s, p.String()) }
func (p PageResult) MarshalJSON() ([]byte, error) { return nil, ErrUnavailable }

type pageCounts struct{ total, pages string }

var pageTotal = regexp.MustCompile(`^(0|[1-9][0-9]{0,2})$`)

// DoPage is GET-only, retains the ordinary 64 KiB body cap and accepts exactly
// one canonical bounded X-WP-Total and X-WP-TotalPages value. It exposes no raw
// headers, redirects or navigation URLs. Adapters still verify page completion.
func (c *Client) DoPage(ctx context.Context, path string, query url.Values, authorization string) (PageResult, error) {
	if c == nil || c.state == nil || c.state.responseLimit != MaxResponseBytes {
		return PageResult{}, ErrUnavailable
	}
	var counts pageCounts
	body, err := c.do(ctx, http.MethodGet, path, query, nil, authorization, "", &counts)
	if err != nil {
		return PageResult{}, err
	}
	return PageResult{Body: body, Total: counts.total, TotalPages: counts.pages}, nil
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body []byte, authorization, contentType string, counts *pageCounts) ([]byte, error) {
	if c == nil || c.state == nil || ctx == nil || ctx.Err() != nil || (method != "GET" && method != "POST") || len(body) > MaxRequestBytes || (method == "GET" && len(body) > 0) || len(authorization) > 4096 || strings.ContainsAny(authorization, "\r\n") || (authorization != "" && !strings.HasPrefix(authorization, "Bearer ") && !strings.HasPrefix(authorization, "Basic ")) {
		return nil, ErrUnavailable
	}
	if c.state.responseLimit != MaxResponseBytes && c.state.responseLimit != MaxMetadataResponseBytes {
		return nil, ErrUnavailable
	}
	if path == "" || !requestPath.MatchString(path) || strings.HasPrefix(path, "//") || len(path) > 512 {
		return nil, ErrUnavailable
	}
	for _, part := range strings.Split(path, "/") {
		if part == "." || part == ".." {
			return nil, ErrUnavailable
		}
	}
	if contentType != "" && contentType != "application/json" && contentType != "application/x-www-form-urlencoded" {
		return nil, ErrUnavailable
	}
	for key, values := range query {
		if !queryKeys[key] || len(values) != 1 || values[0] == "" || len(values[0]) > 2048 {
			return nil, ErrUnavailable
		}
	}
	if len(query.Encode()) > 4096 {
		return nil, ErrUnavailable
	}
	select {
	case c.state.admission.slots <- struct{}{}:
	default:
		return nil, ErrBusy
	}
	defer func() { <-c.state.admission.slots }()
	bounded, cancel := context.WithTimeout(ctx, requestBudget)
	defer cancel()
	u := *c.state.origin
	u.Path += path
	u.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(bounded, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, ErrUnavailable
	}
	request.Header.Set("Accept", "application/json")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	// Transport deliberately detaches its internal dial context from a request
	// deadline for connection pooling. This client disables pooling and binds
	// DNS/TCP/TLS directly to the actual request budget instead. Cleanup waits
	// for an already-started dial/handshake before releasing shared admission.
	transport := c.state.http.Transport.(*http.Transport).Clone()
	rawDial := transport.DialContext
	var lifetime sync.Mutex
	allowed, started := true, false
	finished := make(chan struct{})
	transport.DialTLSContext = func(_ context.Context, network, address string) (net.Conn, error) {
		lifetime.Lock()
		if !allowed || started {
			lifetime.Unlock()
			return nil, ErrUnavailable
		}
		started = true
		lifetime.Unlock()
		defer close(finished)
		dialContext, stopDial := context.WithTimeout(bounded, 2*time.Second)
		connection, err := rawDial(dialContext, network, address)
		stopDial()
		if err != nil {
			return nil, ErrUnavailable
		}
		config := transport.TLSClientConfig.Clone()
		config.ServerName = c.state.origin.Hostname()
		secured := tls.Client(connection, config)
		handshake, stopHandshake := context.WithTimeout(bounded, 3*time.Second)
		err = secured.HandshakeContext(handshake)
		stopHandshake()
		if err != nil {
			_ = secured.Close()
			return nil, ErrUnavailable
		}
		return secured, nil
	}
	defer func() {
		cancel()
		lifetime.Lock()
		allowed = false
		wait := started
		lifetime.Unlock()
		if wait {
			<-finished
		}
		transport.CloseIdleConnections()
	}()
	client := &http.Client{Transport: transport, CheckRedirect: c.state.http.CheckRedirect}
	response, err := client.Do(request)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > int64(c.state.responseLimit) || len(response.Header.Values("Content-Type")) != 1 || response.Header.Get("Content-Encoding") != "" {
		return nil, ErrUnavailable
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, ErrUnavailable
	}
	if counts != nil {
		total, pages := response.Header.Values("X-WP-Total"), response.Header.Values("X-WP-TotalPages")
		if len(total) != 1 || len(pages) != 1 || !pageTotal.MatchString(total[0]) || !pageTotal.MatchString(pages[0]) || len(pages[0]) != 1 || pages[0] > "5" || (len(total[0]) == 3 && total[0] > "500") {
			return nil, ErrUnavailable
		}
		counts.total, counts.pages = total[0], pages[0]
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(c.state.responseLimit)+1))
	if err != nil || len(data) < 1 || len(data) > c.state.responseLimit || bounded.Err() != nil || !utf8.Valid(data) || !json.Valid(data) {
		clear(data)
		return nil, ErrUnavailable
	}
	return data, nil // Adapter owns strict complete JSON/schema interpretation.
}
