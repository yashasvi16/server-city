// Package wsock is a small, server-side-only implementation of RFC 6455
// WebSockets using only the standard library.
//
// It deliberately supports just what the presence hub needs: text and binary
// messages (with fragmentation), ping/pong, and the close handshake. There is
// no compression extension and no client mode.
package wsock

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Opcodes from RFC 6455 section 5.2.
const (
	OpContinuation byte = 0x0
	OpText         byte = 0x1
	OpBinary       byte = 0x2
	OpClose        byte = 0x8
	OpPing         byte = 0x9
	OpPong         byte = 0xA
)

// Close codes used by this package (RFC 6455 section 7.4.1).
const (
	CloseNormal          = 1000
	CloseGoingAway       = 1001
	CloseProtocolError   = 1002
	CloseUnsupportedData = 1003
	CloseInvalidPayload  = 1007
	ClosePolicyViolation = 1008
	CloseTooBig          = 1009
	CloseInternalError   = 1011
)

var (
	ErrProtocol    = errors.New("wsock: protocol error")
	ErrTooBig      = errors.New("wsock: message too big")
	ErrUnmasked    = errors.New("wsock: client frame not masked")
	ErrBadOpcode   = errors.New("wsock: unknown opcode")
	ErrControlSize = errors.New("wsock: control frame too large or fragmented")
)

type frameHeader struct {
	fin    bool
	rsv    byte
	opcode byte
	masked bool
	length uint64
	mask   [4]byte
}

func isControl(op byte) bool { return op&0x8 != 0 }

func validOpcode(op byte) bool {
	switch op {
	case OpContinuation, OpText, OpBinary, OpClose, OpPing, OpPong:
		return true
	}
	return false
}

// readHeader reads and validates one frame header. maxPayload bounds the
// declared payload length so a hostile client cannot make us allocate
// gigabytes from a 14-byte header.
func readHeader(r io.Reader, maxPayload int64) (frameHeader, error) {
	var h frameHeader
	var b [2]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return h, err
	}
	h.fin = b[0]&0x80 != 0
	h.rsv = (b[0] >> 4) & 0x7
	h.opcode = b[0] & 0x0F
	h.masked = b[1]&0x80 != 0
	l := uint64(b[1] & 0x7F)

	if h.rsv != 0 { // no extensions negotiated
		return h, ErrProtocol
	}
	if !validOpcode(h.opcode) {
		return h, ErrBadOpcode
	}
	switch l {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return h, err
		}
		l = uint64(binary.BigEndian.Uint16(ext[:]))
		if l < 126 { // must use minimal encoding
			return h, ErrProtocol
		}
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return h, err
		}
		l = binary.BigEndian.Uint64(ext[:])
		if l>>63 != 0 || l <= 0xFFFF {
			return h, ErrProtocol
		}
	}
	h.length = l
	if isControl(h.opcode) && (l > 125 || !h.fin) {
		return h, ErrControlSize
	}
	if l > uint64(maxPayload) {
		return h, ErrTooBig
	}
	if !h.masked { // RFC 6455 5.1: server MUST close on unmasked client frame
		return h, ErrUnmasked
	}
	if _, err := io.ReadFull(r, h.mask[:]); err != nil {
		return h, err
	}
	return h, nil
}

func unmask(p []byte, mask [4]byte) {
	for i := range p {
		p[i] ^= mask[i&3]
	}
}

// appendFrame encodes a single unmasked server frame.
func appendFrame(dst []byte, fin bool, opcode byte, payload []byte) []byte {
	b0 := opcode
	if fin {
		b0 |= 0x80
	}
	n := len(payload)
	switch {
	case n <= 125:
		dst = append(dst, b0, byte(n))
	case n <= 0xFFFF:
		dst = append(dst, b0, 126, byte(n>>8), byte(n))
	default:
		dst = append(dst, b0, 127)
		dst = binary.BigEndian.AppendUint64(dst, uint64(n))
	}
	return append(dst, payload...)
}

func closePayload(code int, reason string) []byte {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	p := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(p, uint16(code))
	return append(p, reason...)
}

// CloseError is returned by ReadMessage when the peer sent a close frame.
type CloseError struct {
	Code   int
	Reason string
}

func (e *CloseError) Error() string {
	return fmt.Sprintf("wsock: closed by peer (%d %s)", e.Code, e.Reason)
}
