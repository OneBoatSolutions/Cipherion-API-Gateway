package aesgcm

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
)

const (
	KeySize   = 32 // AES-256: 32 bytes
	NonceSize = 12 // Standard GCM nonce size
)

var (
	ErrInvalidKey     = errors.New("AES-256 requires a 32-byte key")
	ErrInvalidPayload = errors.New("invalid encrypted payload")
)

// Encrypt encrypts plaintext and returns a Base64-encoded payload.
// Payload format: nonce || ciphertext || authentication tag.
func Encrypt(plaintext []byte, key []byte) (string, string, string, error) {
	if len(key) != KeySize {
		return "", "", "", ErrInvalidKey
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", "", err
	}

	nonce := make([]byte, NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", "", "", err
	}

	// Seal appends ciphertext and the authentication tag.
	sealed := gcm.Seal(nil, nonce, plaintext, nil)

	tagSize := gcm.Overhead()
	ciphertext := sealed[:len(sealed)-tagSize]
	tag := sealed[len(sealed)-tagSize:]

	// Store the nonce alongside the ciphertext.
	//payload := append(nonce, ciphertext...)

	//return base64.StdEncoding.EncodeToString(payload), nil

	return base64.StdEncoding.EncodeToString(nonce), base64.StdEncoding.EncodeToString(ciphertext), base64.StdEncoding.EncodeToString(tag), nil

}

func Decrypt(ivEncoded, ciphertextEncoded, tagEncoded string, key []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, ErrInvalidKey
	}

	// Decode the Base64-encoded inputs.
	iv, err := base64.StdEncoding.DecodeString(ivEncoded)
	if err != nil {
		return nil, ErrInvalidPayload
	}

	ciphertext, err := base64.StdEncoding.DecodeString(ciphertextEncoded)
	if err != nil {
		return nil, ErrInvalidPayload
	}

	tag, err := base64.StdEncoding.DecodeString(tagEncoded)
	if err != nil {
		return nil, ErrInvalidPayload
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	if len(iv) != gcm.NonceSize() {
		return nil, ErrInvalidPayload
	}

	if len(tag) != gcm.Overhead() {
		return nil, ErrInvalidPayload
	}

	// Go's GCM Open expects ciphertext followed by the authentication tag.
	ciphertextWithTag := make([]byte, 0, len(ciphertext)+len(tag))
	ciphertextWithTag = append(ciphertextWithTag, ciphertext...)
	ciphertextWithTag = append(ciphertextWithTag, tag...)

	plaintext, err := gcm.Open(nil, iv, ciphertextWithTag, nil)
	if err != nil {
		// Authentication failed, or the payload was modified.
		return nil, ErrInvalidPayload
	}

	return plaintext, nil
}
