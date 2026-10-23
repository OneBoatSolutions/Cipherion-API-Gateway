package pbkdf

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

const (
	SaltSize       = 16
	DerivedKeySize = 32
	Iterations     = 600_000
)

func DeriveKey(passphrase string, salt []byte) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase must not be empty")
	}

	if len(salt) != SaltSize {
		return nil, errors.New("salt must be exactly 16 bytes")
	}

	key, err := pbkdf2.Key(
		sha256.New,
		passphrase,
		salt,
		Iterations,
		DerivedKeySize,
	)
	if err != nil {
		return nil, err
	}

	return key, nil
}

func GenerateSalt() ([]byte, error) {
	salt := make([]byte, SaltSize)

	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}

	return salt, nil
}
