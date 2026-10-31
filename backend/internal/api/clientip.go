package api

import (
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// ClientIP resolves the visitor's address used as the rate-limit key.
//
// A forwarding header is only trusted when explicitly configured, because
// anyone can send X-Forwarded-For. For X-Forwarded-For we count from the
// right: entries are appended by each proxy, and everything left of what our
// own proxies added is client-controlled. "X-Forwarded-For" takes the
// right-most entry (one proxy in front of us, e.g. Caddy or Fly). On hosts
// with more proxies, "X-Forwarded-For:N" skips the N right-most entries
// first; on Render, which appends its own hop after the visitor's address,
// that is "X-Forwarded-For:1".
//
// IPv6 addresses are collapsed to their /64 prefix, since a single host
// typically controls a whole /64 and could otherwise rotate addresses to
// dodge per-IP limits.
func ClientIP(r *http.Request, header string) string {
	raw := ""
	if header != "" {
		name, skip := header, 0
		if n, k, ok := strings.Cut(header, ":"); ok {
			if v, err := strconv.Atoi(strings.TrimSpace(k)); err == nil && v >= 0 {
				name, skip = strings.TrimSpace(n), v
			}
		}
		v := strings.Join(r.Header.Values(name), ",")
		if strings.EqualFold(name, "X-Forwarded-For") {
			parts := strings.Split(v, ",")
			v = ""
			if i := len(parts) - 1 - skip; i >= 0 {
				v = parts[i]
			}
		}
		raw = strings.TrimSpace(v)
	}
	if raw == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		raw = host
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return "invalid"
	}
	addr = addr.Unmap()
	if addr.Is6() {
		p, _ := addr.Prefix(64)
		return p.String()
	}
	return addr.String()
}
