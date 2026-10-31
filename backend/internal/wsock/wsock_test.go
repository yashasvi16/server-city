package wsock

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// RFC 6455 section 1.3 example.
func TestAcceptKey(t *testing.T) {
	if got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("AcceptKey = %q", got)
	}
}

func TestReadHeaderValidation(t *testing.T) {
	mask := []byte{1, 2, 3, 4}
	cases := []struct {
		name string
		raw  []byte
		want error
	}{
		{"unmasked", []byte{0x81, 0x01, 'a'}, ErrUnmasked},
		{"rsv set", append([]byte{0xC1, 0x81}, mask...), ErrProtocol},
		{"bad opcode", append([]byte{0x83, 0x80}, mask...), ErrBadOpcode},
		{"fragmented ping", append([]byte{0x09, 0x80}, mask...), ErrControlSize},
		{"big ping", append([]byte{0x89, 0xFE, 0x00, 0x7E}, mask...), ErrControlSize},
		{"non-minimal 16-bit", append([]byte{0x81, 0xFE, 0x00, 0x05}, mask...), ErrProtocol},
		{"too big", append([]byte{0x82, 0xFE, 0x10, 0x00}, mask...), ErrTooBig},
		{"huge 64-bit", append([]byte{0x82, 0xFF, 0x80, 0, 0, 0, 0, 0, 0, 0}, mask...), ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := readHeader(bytes.NewReader(tc.raw), 1024)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestAppendFrameLengths(t *testing.T) {
	for _, n := range []int{0, 125, 126, 65535, 65536} {
		f := appendFrame(nil, true, OpBinary, make([]byte, n))
		var hdr int
		switch {
		case n <= 125:
			hdr = 2
		case n <= 0xFFFF:
			hdr = 4
		default:
			hdr = 10
		}
		if len(f) != hdr+n {
			t.Fatalf("n=%d: frame len %d, want %d", n, len(f), hdr+n)
		}
	}
}

// --- tiny test client -------------------------------------------------------

type testClient struct {
	nc net.Conn
	br *bufio.Reader
}

func dial(t *testing.T, url string, origin string) *testClient {
	t.Helper()
	addr := strings.TrimPrefix(url, "http://")
	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	req := "GET /ws HTTP/1.1\r\nHost: " + addr + "\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
	if origin != "" {
		req += "Origin: " + origin + "\r\n"
	}
	req += "\r\n"
	if _, err := nc.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("bad accept header")
	}
	return &testClient{nc: nc, br: br}
}

func (c *testClient) send(t *testing.T, fin bool, op byte, payload []byte) {
	t.Helper()
	b0 := op
	if fin {
		b0 |= 0x80
	}
	var f []byte
	n := len(payload)
	switch {
	case n <= 125:
		f = []byte{b0, 0x80 | byte(n)}
	case n <= 0xFFFF:
		f = []byte{b0, 0x80 | 126, byte(n >> 8), byte(n)}
	default:
		f = []byte{b0, 0x80 | 127}
		f = binary.BigEndian.AppendUint64(f, uint64(n))
	}
	mask := [4]byte{0x37, 0xfa, 0x21, 0x3d}
	f = append(f, mask[:]...)
	p := append([]byte(nil), payload...)
	unmask(p, mask)
	f = append(f, p...)
	if _, err := c.nc.Write(f); err != nil {
		t.Fatal(err)
	}
}

func (c *testClient) recv(t *testing.T) (byte, []byte) {
	t.Helper()
	_ = c.nc.SetReadDeadline(time.Now().Add(2 * time.Second))
	var b [2]byte
	if _, err := io.ReadFull(c.br, b[:]); err != nil {
		t.Fatal(err)
	}
	if b[1]&0x80 != 0 {
		t.Fatal("server frame must not be masked")
	}
	n := uint64(b[1] & 0x7f)
	if n == 126 {
		var e [2]byte
		io.ReadFull(c.br, e[:])
		n = uint64(binary.BigEndian.Uint16(e[:]))
	} else if n == 127 {
		var e [8]byte
		io.ReadFull(c.br, e[:])
		n = binary.BigEndian.Uint64(e[:])
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(c.br, p); err != nil {
		t.Fatal(err)
	}
	return b[0] & 0x0f, p
}

func echoServer(t *testing.T, opt Options) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrade(w, r, opt)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			_, msg, err := c.ReadMessage(nil)
			if err != nil {
				return
			}
			if err := c.WriteText(msg, time.Second); err != nil {
				return
			}
		}
	}))
}

func TestEchoFragmentedAndPing(t *testing.T) {
	srv := echoServer(t, Options{MaxMessage: 1 << 17})
	defer srv.Close()
	c := dial(t, srv.URL, "")
	defer c.nc.Close()

	c.send(t, true, OpText, []byte("hello"))
	if op, p := c.recv(t); op != OpText || string(p) != "hello" {
		t.Fatalf("got %d %q", op, p)
	}

	// Fragmented message with an interleaved ping (allowed by the RFC).
	c.send(t, false, OpText, []byte("hel"))
	c.send(t, true, OpPing, []byte("p"))
	if op, p := c.recv(t); op != OpPong || string(p) != "p" {
		t.Fatalf("expected pong, got %d %q", op, p)
	}
	c.send(t, true, OpContinuation, []byte("lo world"))
	if _, p := c.recv(t); string(p) != "hello world" {
		t.Fatalf("got %q", p)
	}

	big := bytes.Repeat([]byte("x"), 70000)
	c.send(t, true, OpBinary, big)
	if _, p := c.recv(t); !bytes.Equal(p, big) {
		t.Fatalf("64-bit length echo mismatch (len %d)", len(p))
	}

	c.send(t, true, OpClose, closePayload(CloseNormal, "bye"))
	op, p := c.recv(t)
	if op != OpClose || binary.BigEndian.Uint16(p) != CloseNormal {
		t.Fatalf("expected close reply, got %d %v", op, p)
	}
}

func TestOversizeMessageClosesWith1009(t *testing.T) {
	srv := echoServer(t, Options{MaxMessage: 16})
	defer srv.Close()
	c := dial(t, srv.URL, "")
	defer c.nc.Close()
	// Two fragments that are individually fine but too big together.
	c.send(t, false, OpText, []byte("0123456789"))
	c.send(t, true, OpContinuation, []byte("0123456789"))
	op, p := c.recv(t)
	if op != OpClose || binary.BigEndian.Uint16(p) != CloseTooBig {
		t.Fatalf("expected 1009, got op=%d %v", op, p)
	}
}

func TestInvalidUTF8Closes(t *testing.T) {
	srv := echoServer(t, Options{})
	defer srv.Close()
	c := dial(t, srv.URL, "")
	defer c.nc.Close()
	c.send(t, true, OpText, []byte{0xff, 0xfe})
	op, p := c.recv(t)
	if op != OpClose || binary.BigEndian.Uint16(p) != CloseInvalidPayload {
		t.Fatalf("expected 1007, got op=%d %v", op, p)
	}
}

func TestHandshakeRejections(t *testing.T) {
	srv := echoServer(t, Options{CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == "https://ok.example"
	}})
	defer srv.Close()

	do := func(mod func(*http.Request)) int {
		req, _ := http.NewRequest("GET", srv.URL+"/ws", nil)
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Sec-WebSocket-Version", "13")
		req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		req.Header.Set("Origin", "https://ok.example")
		mod(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if s := do(func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }); s != http.StatusForbidden {
		t.Errorf("bad origin: %d", s)
	}
	if s := do(func(r *http.Request) { r.Header.Set("Sec-WebSocket-Version", "8") }); s != http.StatusUpgradeRequired {
		t.Errorf("bad version: %d", s)
	}
	if s := do(func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "short") }); s != http.StatusBadRequest {
		t.Errorf("bad key: %d", s)
	}
	if s := do(func(r *http.Request) { r.Header.Del("Upgrade") }); s != http.StatusBadRequest {
		t.Errorf("no upgrade: %d", s)
	}
}
