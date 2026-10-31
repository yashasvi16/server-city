// Package wstest is a minimal masking WebSocket client used by tests in
// other packages (and handy for quick load scripts). Not for production use.
package wstest

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Client is a test WebSocket client.
type Client struct {
	NC net.Conn
	br *bufio.Reader
}

// Dial performs the opening handshake against an http:// base URL + path.
func Dial(baseURL, path string, header http.Header) (*Client, *http.Response, error) {
	addr := strings.TrimPrefix(baseURL, "http://")
	nc, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return nil, nil, err
	}
	var k [16]byte
	_, _ = rand.Read(k[:])
	var b strings.Builder
	fmt.Fprintf(&b, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n", path, addr)
	fmt.Fprintf(&b, "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", base64.StdEncoding.EncodeToString(k[:]))
	for name, vals := range header {
		for _, v := range vals {
			fmt.Fprintf(&b, "%s: %s\r\n", name, v)
		}
	}
	b.WriteString("\r\n")
	if _, err := nc.Write([]byte(b.String())); err != nil {
		nc.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		nc.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		nc.Close()
		return nil, resp, fmt.Errorf("handshake status %d", resp.StatusCode)
	}
	return &Client{NC: nc, br: br}, resp, nil
}

// Send writes one masked, final frame.
func (c *Client) Send(op byte, payload []byte) error {
	f := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n <= 125:
		f = append(f, 0x80|byte(n))
	case n <= 0xFFFF:
		f = append(f, 0x80|126, byte(n>>8), byte(n))
	default:
		f = append(f, 0x80|127)
		f = binary.BigEndian.AppendUint64(f, uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	f = append(f, mask[:]...)
	for i, b := range payload {
		f = append(f, b^mask[i&3])
	}
	_, err := c.NC.Write(f)
	return err
}

// SendText sends a text frame.
func (c *Client) SendText(s string) error { return c.Send(0x1, []byte(s)) }

// Recv reads one (unfragmented) server frame.
func (c *Client) Recv(timeout time.Duration) (op byte, payload []byte, err error) {
	_ = c.NC.SetReadDeadline(time.Now().Add(timeout))
	var h [2]byte
	if _, err = io.ReadFull(c.br, h[:]); err != nil {
		return
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var e [2]byte
		if _, err = io.ReadFull(c.br, e[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(e[:]))
	case 127:
		var e [8]byte
		if _, err = io.ReadFull(c.br, e[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(e[:])
	}
	payload = make([]byte, n)
	_, err = io.ReadFull(c.br, payload)
	return h[0] & 0x0f, payload, err
}

// RecvText skips control frames (answering nothing) and returns the next
// text payload. A close frame is returned as an error.
func (c *Client) RecvText(timeout time.Duration) ([]byte, error) {
	deadline := time.Now().Add(timeout)
	for {
		op, p, err := c.Recv(time.Until(deadline))
		if err != nil {
			return nil, err
		}
		switch op {
		case 0x1:
			return p, nil
		case 0x8:
			code := 0
			if len(p) >= 2 {
				code = int(binary.BigEndian.Uint16(p))
			}
			return nil, &CloseErr{Code: code}
		}
	}
}

// CloseErr reports a close frame from the server.
type CloseErr struct{ Code int }

func (e *CloseErr) Error() string { return fmt.Sprintf("closed %d", e.Code) }

// Close closes the TCP connection.
func (c *Client) Close() error { return c.NC.Close() }
