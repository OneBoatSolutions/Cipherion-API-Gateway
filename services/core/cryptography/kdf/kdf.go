
package kdf

import (
	"crypto/hkdf"
	"crypto/sha256"
	"errors"
)

const HKDFKeySize = 32

var ErrInvalidIKM = errors.New("input key material must not be empty")

// DeriveHKDFKey derives a 32-byte key using HKDF-SHA-256.
//
// ikm: combined secret input key material.
// salt: optional, non-secret salt.
// info: application-specific context string.
func DeriveHKDFKey(ikm, salt, info []byte) ([]byte, error) {
	if len(ikm) == 0 {
		return nil, ErrInvalidIKM
	}

	key, err := hkdf.Key(
		sha256.New,
		ikm,
		salt,
		string(info),
		HKDFKeySize,
	)
	if err != nil {
		return nil, err
	}

	return key, nil
}

