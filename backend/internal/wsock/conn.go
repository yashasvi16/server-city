package wsock

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// AcceptKey computes Sec-WebSocket-Accept for a client key.
func AcceptKey(key string) string {
	h := sha1.New()
	h.Write([]byte(key))
	h.Write([]byte(acceptGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// Options controls the upgrade.
type Options struct {
	// MaxMessage is the largest reassembled message accepted, in bytes.
	MaxMessage int64
	// CheckOrigin returns true if the Origin header is acceptable.
	// nil means same-host only.
	CheckOrigin func(r *http.Request) bool
}

// Conn is a server-side WebSocket connection. ReadMessage must be called from
// one goroutine; WriteMessage, Ping and Close are safe for concurrent use.
type Conn struct {
	nc         net.Conn
	br         *bufio.Reader
	maxMessage int64

	wmu    sync.Mutex
	closed bool
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func sameHost(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser clients
	}
	i := strings.Index(origin, "://")
	return i >= 0 && strings.EqualFold(origin[i+3:], r.Host)
}

// Upgrade validates the handshake and hijacks the connection. On failure it
// writes an HTTP error and returns a non-nil error.
func Upgrade(w http.ResponseWriter, r *http.Request, opt Options) (*Conn, error) {
	fail := func(status int, msg string) (*Conn, error) {
		http.Error(w, msg, status)
		return nil, errors.New("wsock: " + msg)
	}
	if r.Method != http.MethodGet {
		return fail(http.StatusMethodNotAllowed, "method not allowed")
	}
	if !headerHasToken(r.Header, "Connection", "upgrade") || !headerHasToken(r.Header, "Upgrade", "websocket") {
		return fail(http.StatusBadRequest, "not a websocket handshake")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		return fail(http.StatusUpgradeRequired, "unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		return fail(http.StatusBadRequest, "bad websocket key")
	}
	check := opt.CheckOrigin
	if check == nil {
		check = sameHost
	}
	if !check(r) {
		return fail(http.StatusForbidden, "origin not allowed")
	}
	if opt.MaxMessage <= 0 {
		opt.MaxMessage = 4096
	}

	rc := http.NewResponseController(w)
	nc, brw, err := rc.Hijack()
	if err != nil {
		return fail(http.StatusInternalServerError, "hijack not supported")
	}
	// Clear any deadlines the http.Server set for the request.
	_ = nc.SetDeadline(time.Time{})

	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + AcceptKey(key) + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		nc.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		nc.Close()
		return nil, err
	}
	return &Conn{nc: nc, br: brw.Reader, maxMessage: opt.MaxMessage}, nil
}

// SetReadDeadline sets the deadline for the next read.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.nc.SetReadDeadline(t) }

// RemoteAddr returns the peer address.
func (c *Conn) RemoteAddr() net.Addr { return c.nc.RemoteAddr() }

// ReadMessage returns the next complete data message. Control frames are
// handled internally (ping -> pong, close -> close reply + *CloseError).
// onPong, if set, is invoked for every pong received.
func (c *Conn) ReadMessage(onPong func()) (opcode byte, data []byte, err error) {
	var msgOp byte
	var buf []byte
	for {
		h, err := readHeader(c.br, c.maxMessage)
		if err != nil {
			c.closeWithError(err)
			return 0, nil, err
		}
		payload := make([]byte, h.length)
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return 0, nil, err
		}
		unmask(payload, h.mask)

		switch h.opcode {
		case OpPing:
			if err := c.write(OpPong, payload, time.Now().Add(5*time.Second)); err != nil {
				return 0, nil, err
			}
			continue
		case OpPong:
			if onPong != nil {
				onPong()
			}
			continue
		case OpClose:
			ce := &CloseError{Code: 1005}
			if len(payload) >= 2 {
				ce.Code = int(binary.BigEndian.Uint16(payload))
				ce.Reason = string(payload[2:])
			}
			_ = c.CloseWith(CloseNormal, "")
			return 0, nil, ce
		case OpContinuation:
			if msgOp == 0 {
				c.closeWithError(ErrProtocol)
				return 0, nil, ErrProtocol
			}
		default: // text or binary starts a new message
			if msgOp != 0 {
				c.closeWithError(ErrProtocol)
				return 0, nil, ErrProtocol
			}
			msgOp = h.opcode
		}

		if int64(len(buf))+int64(len(payload)) > c.maxMessage {
			c.closeWithError(ErrTooBig)
			return 0, nil, ErrTooBig
		}
		buf = append(buf, payload...)
		if h.fin {
			if msgOp == OpText && !utf8.Valid(buf) {
				_ = c.CloseWith(CloseInvalidPayload, "invalid utf-8")
				return 0, nil, ErrProtocol
			}
			return msgOp, buf, nil
		}
	}
}

func (c *Conn) closeWithError(err error) {
	switch {
	case errors.Is(err, ErrTooBig):
		_ = c.CloseWith(CloseTooBig, "message too big")
	case errors.Is(err, ErrProtocol), errors.Is(err, ErrUnmasked),
		errors.Is(err, ErrBadOpcode), errors.Is(err, ErrControlSize):
		_ = c.CloseWith(CloseProtocolError, "protocol error")
	}
}

func (c *Conn) write(op byte, payload []byte, deadline time.Time) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	_ = c.nc.SetWriteDeadline(deadline)
	_, err := c.nc.Write(appendFrame(nil, true, op, payload))
	return err
}

// WriteText sends a text message, giving up after timeout.
func (c *Conn) WriteText(p []byte, timeout time.Duration) error {
	return c.write(OpText, p, time.Now().Add(timeout))
}

// Ping sends a ping control frame.
func (c *Conn) Ping(timeout time.Duration) error {
	return c.write(OpPing, nil, time.Now().Add(timeout))
}

// CloseWith sends a close frame (best effort) and closes the socket.
// It is idempotent.
func (c *Conn) CloseWith(code int, reason string) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	_ = c.nc.SetWriteDeadline(time.Now().Add(time.Second))
	_, _ = c.nc.Write(appendFrame(nil, true, OpClose, closePayload(code, reason)))
	return c.nc.Close()
}

// Close closes with 1000 Normal Closure.
func (c *Conn) Close() error { return c.CloseWith(CloseNormal, "") }
