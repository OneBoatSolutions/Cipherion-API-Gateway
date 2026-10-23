// Package callbackHandler implements the grpcCallBackfromNest gRPC API (proto/prototypeBufferV1.proto).
// It is the thin layer between gRPC and the pure crypto code in cryptography/aesgcm:
// it validates the request, calls aesgcm, and maps the result (or error) to the reply.
package callbackHandler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"cipsec/services/core/cryptography/aesgcm"
	"cipsec/services/core/cryptography/kdf"
	"cipsec/services/core/cryptography/pbkdf"
	prototypeBufferV1 "cipsec/services/core/generated/v1"
)

// Service implements prototypeBufferV1.GrpcCallBackfromNestServer.
type Service struct {
	// Keeps us compiling if the proto gains RPCs we have not implemented yet.
	prototypeBufferV1.UnimplementedGrpcCallBackfromNestServer
	// The Cipherion Root Key, used to wrap project keys. Supplied at startup
	// (see CIPHERION_ROOT_KEY in cmd/server/main.go); never logged or returned.
	rootKey []byte
}

// NewService fails fast if the root key is not a valid AES-256 key (32 bytes).
func NewService(rootKey []byte) (*Service, error) {
	if len(rootKey) != aesgcm.KeySize {
		return nil, aesgcm.ErrInvalidKey
	}
	return &Service{rootKey: rootKey}, nil
}

func generateCrytograhicallySecure_32ByteKey() ([]byte, error) {
	key := make([]byte, aesgcm.KeySize)
	if _, err := rand.Read(key); err != nil {
		// Log the detail here; send the caller a generic message.
		log.Printf("kms: generate project root key: %v", err)
		return nil, status.Error(codes.Internal, "could not generate key")
	}

	return key, nil
}

// CreateAndWrapNewProjectRootKey generates a fresh Project Root Key (PRK), wraps it
// with the Cipherion Root Key, and returns only the wrapped form. The plaintext PRK
// never leaves this function.
func (s *Service) CreateAndWrapNewProjectRootKey(ctx context.Context, req *prototypeBufferV1.CreateAndWrapNewProjectRootKey_Request) (*prototypeBufferV1.CreateAndWrapNewProjectRootKey_Response, error) {
	// Bad input is a gRPC error: the caller (the gateway) has a bug.
	if req.ProjectId == "" {
		return nil, status.Error(codes.InvalidArgument, "projectId is required")
	}

	prk := make([]byte, aesgcm.KeySize)
	if _, err := rand.Read(prk); err != nil {
		// Log the detail here; send the caller a generic message.
		log.Printf("kms: generate project root key: %v", err)
		return nil, status.Error(codes.Internal, "could not generate key")
	}

	// aesgcm returns one base64 string: nonce || ciphertext || auth tag.
	iv, ciphertext, tag, err := aesgcm.Encrypt(prk, s.rootKey)
	if err != nil {
		log.Printf("kms: wrap project root key: %v", err)
		return nil, status.Error(codes.Internal, "could not wrap key")
	}

	return &prototypeBufferV1.CreateAndWrapNewProjectRootKey_Response{
		ProjectId:                req.ProjectId,
		WrappedProjectRootKeyIV:  iv,
		WrappedProjectRootKey:    ciphertext,
		WrappedProjectRootKeyTag: tag,
	}, nil
}

// ---- helpers shared by the passphrase-protected operations -----------------

// hkdfInfo binds derived keys to this application and format version.
// Changing it makes every stored project encryption key unreadable.
const hkdfInfo = "cipsec/v1/kdf"

// wrapped is one AES-GCM-wrapped value, as the three base64 strings the API carries.
type wrapped struct{ iv, ciphertext, tag string }

// deriveProjectWrappingKey derives the key that wraps a project's encryption key:
//
//	HKDF-SHA256( projectRootKey || PBKDF2(passphrase, salt), salt, info )
//
// Opening the result needs both the project root key (which only this server can unwrap)
// and the user's passphrase.
func deriveProjectWrappingKey(projectRootKey []byte, passphrase string, salt []byte) ([]byte, error) {
	stretched, err := pbkdf.DeriveKey(passphrase, salt)
	if err != nil {
		return nil, err
	}
	ikm := make([]byte, 0, len(projectRootKey)+len(stretched))
	ikm = append(ikm, projectRootKey...)
	ikm = append(ikm, stretched...)
	return kdf.DeriveHKDFKey(ikm, salt, []byte(hkdfInfo))
}

// unwrapProjectKeys unwraps the project root key with the Cipherion Root Key, then the project
// encryption key with the passphrase. Every failure is a gRPC status error:
//
//	InvalidArgument  - missing or malformed input, or the stored project root key does not unwrap
//	PermissionDenied - the project encryption key does not unwrap: the passphrase is wrong
//	                   (AES-GCM cannot tell a wrong passphrase from tampered data, so both look alike)
func (s *Service) unwrapProjectKeys(prk, pek wrapped, passphrase, saltB64 string) (projectRootKey, projectEncryptionKey []byte, err error) {
	if passphrase == "" {
		return nil, nil, status.Error(codes.InvalidArgument, "passphrase is required")
	}
	salt, decodeErr := base64.StdEncoding.DecodeString(saltB64)
	if decodeErr != nil || len(salt) != pbkdf.SaltSize {
		return nil, nil, status.Error(codes.InvalidArgument, "passphrase salt is invalid")
	}

	projectRootKey, unwrapErr := aesgcm.Decrypt(prk.iv, prk.ciphertext, prk.tag, s.rootKey)
	if unwrapErr != nil {
		return nil, nil, status.Error(codes.InvalidArgument, "could not unwrap the project root key")
	}

	wrappingKey, deriveErr := deriveProjectWrappingKey(projectRootKey, passphrase, salt)
	if deriveErr != nil {
		log.Printf("kms: derive wrapping key: %v", deriveErr)
		return nil, nil, status.Error(codes.Internal, "could not derive the wrapping key")
	}

	projectEncryptionKey, unwrapErr = aesgcm.Decrypt(pek.iv, pek.ciphertext, pek.tag, wrappingKey)
	if unwrapErr != nil {
		return nil, nil, status.Error(codes.PermissionDenied, "incorrect passphrase")
	}
	return projectRootKey, projectEncryptionKey, nil
}

// CreateAndWrapNewProjectEncryptionKey creates the Project Encryption Key (PEK) and wraps it with a
// key derived from the project root key and the user's passphrase. It also returns the random salt
// used for that derivation; the caller must store it, because it is needed to unwrap the PEK later.
func (s *Service) CreateAndWrapNewProjectEncryptionKey(ctx context.Context, req *prototypeBufferV1.CreateAndWrapNewProjectEncryptionKey_Request) (*prototypeBufferV1.CreateAndWrapNewProjectEncryptionKey_Response, error) {

	// Bad input is a gRPC error: the caller (the gateway) has a bug.
	if req.ProjectId == "" {
		return nil, status.Error(codes.InvalidArgument, "projectId is required")
	}
	if req.UserPassphrase == "" {
		return nil, status.Error(codes.InvalidArgument, "userPassphrase is required")
	}

	projectRootKey, err := aesgcm.Decrypt(req.WrappedProjectRootKeyIV, req.WrappedProjectRootKey, req.WrappedProjectRootKeyTag, s.rootKey)
	if err != nil {
		// Decryption failed, or the stored value was modified.
		return nil, status.Error(codes.InvalidArgument, "could not unwrap the project root key")
	}

	projectEncryptionKey, err := generateCrytograhicallySecure_32ByteKey()
	if err != nil {
		return nil, err // already a gRPC status error, and already logged
	}

	salt, err := pbkdf.GenerateSalt()
	if err != nil {
		log.Printf("kms: generate salt: %v", err)
		return nil, status.Error(codes.Internal, "could not generate a salt")
	}

	wrappingKey, err := deriveProjectWrappingKey(projectRootKey, req.UserPassphrase, salt)
	if err != nil {
		log.Printf("kms: derive wrapping key: %v", err)
		return nil, status.Error(codes.Internal, "could not derive the wrapping key")
	}

	iv, ciphertext, tag, err := aesgcm.Encrypt(projectEncryptionKey, wrappingKey)
	if err != nil {
		log.Printf("kms: wrap project encryption key: %v", err)
		return nil, status.Error(codes.Internal, "key wrapping failed")
	}

	return &prototypeBufferV1.CreateAndWrapNewProjectEncryptionKey_Response{
		ProjectId:                      req.ProjectId,
		WrappedProjectEncryptionKeyIV:  iv,
		WrappedProjectEncryptionKey:    ciphertext,
		WrappedProjectEncryptionKeyTag: tag,
		UserPassphraseSalt:             base64.StdEncoding.EncodeToString(salt),
	}, nil
}

// CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey creates a Group Root Key (GRK) and a Group Data
// Encryption Key (GDEK). The GDEK is wrapped with the GRK, and the GRK with the project encryption key,
// which is why the user's passphrase is needed. A wrong passphrase is refused before any key is made.
func (s *Service) CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(ctx context.Context, req *prototypeBufferV1.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) (*prototypeBufferV1.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Response, error) {

	// Bad input is a gRPC error: the caller (the gateway) has a bug.
	if req.GroupId == "" {
		return nil, status.Error(codes.InvalidArgument, "groupId is required")
	}

	_, projectEncryptionKey, err := s.unwrapProjectKeys(
		wrapped{req.WrappedProjectRootKeyIV, req.WrappedProjectRootKey, req.WrappedProjectRootKeyTag},
		wrapped{req.WrappedProjectEncryptionKeyIV, req.WrappedProjectEncryptionKey, req.WrappedProjectEncryptionKeyTag},
		req.UserPassphrase, req.UserPassphraseSalt,
	)
	if err != nil {
		return nil, err
	}

	groupRootKey, err := generateCrytograhicallySecure_32ByteKey()
	if err != nil {
		return nil, err
	}
	groupDataEncryptionKey, err := generateCrytograhicallySecure_32ByteKey()
	if err != nil {
		return nil, err
	}

	gdekIV, gdekCiphertext, gdekTag, err := aesgcm.Encrypt(groupDataEncryptionKey, groupRootKey)
	if err != nil {
		log.Printf("kms: wrap group data encryption key: %v", err)
		return nil, status.Error(codes.Internal, "key wrapping failed")
	}
	grkIV, grkCiphertext, grkTag, err := aesgcm.Encrypt(groupRootKey, projectEncryptionKey)
	if err != nil {
		log.Printf("kms: wrap group root key: %v", err)
		return nil, status.Error(codes.Internal, "key wrapping failed")
	}

	return &prototypeBufferV1.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Response{
		GroupId:                          req.GroupId,
		WrappedGroupRootKeyIV:            grkIV,
		WrappedGroupRootKey:              grkCiphertext,
		WrappedGroupRootKeyTag:           grkTag,
		WrappedGroupDataEncryptionKeyIV:  gdekIV,
		WrappedGroupDataEncryptionKey:    gdekCiphertext,
		WrappedGroupDataEncryptionKeyTag: gdekTag,
	}, nil
}

func (s *Service) CreateAndWrapNewDeviceGroupDataEncryptionKey(ctx context.Context, req *prototypeBufferV1.CreateAndWrapNewDeviceGroupDataEncryptionKey_Request) (*prototypeBufferV1.CreateAndWrapNewDeviceGroupDataEncryptionKey_Response, error) {

	// Bad input is a gRPC error: the caller (the gateway) has a bug.
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "projectId is required")
	}

	ProjectRootKey, error := aesgcm.Decrypt(req.WrappedProjectRootKeyIV, req.WrappedProjectRootKey, req.WrappedProjectRootKeyTag, s.rootKey)

	if error != nil {
		// Decryption failed, or the payload was modified.
		return nil, status.Error(codes.InvalidArgument, "Failed to decrpyt")
	}

	salt, error := base64.StdEncoding.DecodeString(req.UserPassphraseSalt)

	userPassphrase_32B_KDF, error := pbkdf.DeriveKey(req.UserPassphrase, salt)

	combinedKey := make([]byte, 0, len(ProjectRootKey)+len(userPassphrase_32B_KDF))

	combinedKey = append(combinedKey, ProjectRootKey...)

	combinedKey = append(combinedKey, userPassphrase_32B_KDF...)

	info := []byte("cipsec/v1/kdf")

	wrappingKey, error := kdf.DeriveHKDFKey(combinedKey, salt, info)

	ProjectEncryptionKey, error := aesgcm.Decrypt(req.WrappedProjectEncryptionKeyIV, req.WrappedProjectEncryptionKey, req.WrappedProjectEncryptionKeyTag, wrappingKey)

	GroupRootKey, error := aesgcm.Decrypt(req.WrappedGroupRootKeyIV, req.WrappedGroupRootKey, req.WrappedGroupRootKeyTag, ProjectEncryptionKey)

	GroupDataEncryptionKey, error := aesgcm.Decrypt(req.WrappedGroupDataEncryptionKeyIV, req.WrappedGroupDataEncryptionKey, req.WrappedGroupDataEncryptionKeyTag, GroupRootKey)

	UserDevicePublicKey, error := base64.StdEncoding.DecodeString(req.UserDevicePublicKey)

	wrappedDeviceGroupDataEncryptionKeyIV, wrappedDeviceGroupDataEncryptionKey, wrappedDeviceGroupDataEncryptionKeyTag, error := aesgcm.Encrypt(GroupDataEncryptionKey, UserDevicePublicKey)

	return &prototypeBufferV1.CreateAndWrapNewDeviceGroupDataEncryptionKey_Response{
		DeviceId:                               req.DeviceId,
		WrappedDeviceGroupDataEncryptionKeyIV:  wrappedDeviceGroupDataEncryptionKeyIV,
		WrappedDeviceGroupDataEncryptionKey:    wrappedDeviceGroupDataEncryptionKey,
		WrappedDeviceGroupDataEncryptionKeyTag: wrappedDeviceGroupDataEncryptionKeyTag,
	}, nil
}

// RotateWrappingKeyforProjectEncryptionKey changes the passphrase protecting a project: it unwraps the
// project encryption key with the CURRENT passphrase and wraps the same key again with the NEW one,
// using a fresh salt. The project encryption key itself does not change, so groups created earlier
// keep working. The project root key does not change, so only the encryption-key values are returned.
func (s *Service) RotateWrappingKeyforProjectEncryptionKey(ctx context.Context, req *prototypeBufferV1.RotateWrappingKeyforProjectEncryptionKey_Request) (*prototypeBufferV1.RotateWrappingKeyforProjectEncryptionKey_Response, error) {

	// Bad input is a gRPC error: the caller (the gateway) has a bug.
	if req.ProjectId == "" {
		return nil, status.Error(codes.InvalidArgument, "projectId is required")
	}
	if req.CurrentUserPassphrase == "" {
		return nil, status.Error(codes.InvalidArgument, "currentUserPassphrase is required")
	}
	if req.NewUserPassphrase == "" {
		return nil, status.Error(codes.InvalidArgument, "newUserPassphrase is required")
	}
	if req.NewUserPassphrase == req.CurrentUserPassphrase {
		return nil, status.Error(codes.InvalidArgument, "the new passphrase must differ from the current one")
	}

	projectRootKey, projectEncryptionKey, err := s.unwrapProjectKeys(
		wrapped{req.CurrentWrappedProjectRootKeyIV, req.CurrentWrappedProjectRootKey, req.CurrentWrappedProjectRootKeyTag},
		wrapped{req.CurrentWrappedProjectEncryptionKeyIV, req.CurrentWrappedProjectEncryptionKey, req.CurrentWrappedProjectEncryptionKeyTag},
		req.CurrentUserPassphrase, req.CurrentUserPassphraseSalt,
	)
	if err != nil {
		return nil, err
	}

	newSalt, err := pbkdf.GenerateSalt()
	if err != nil {
		log.Printf("kms: generate salt: %v", err)
		return nil, status.Error(codes.Internal, "could not generate a salt")
	}

	newWrappingKey, err := deriveProjectWrappingKey(projectRootKey, req.NewUserPassphrase, newSalt)
	if err != nil {
		log.Printf("kms: derive new wrapping key: %v", err)
		return nil, status.Error(codes.Internal, "could not derive the wrapping key")
	}

	iv, ciphertext, tag, err := aesgcm.Encrypt(projectEncryptionKey, newWrappingKey)
	if err != nil {
		log.Printf("kms: re-wrap project encryption key: %v", err)
		return nil, status.Error(codes.Internal, "key wrapping failed")
	}

	return &prototypeBufferV1.RotateWrappingKeyforProjectEncryptionKey_Response{
		ProjectId:                         req.ProjectId,
		NewWrappedProjectEncryptionKeyIV:  iv,
		NewWrappedProjectEncryptionKey:    ciphertext,
		NewWrappedProjectEncryptionKeyTag: tag,
		NewUserPassphraseSalt:             base64.StdEncoding.EncodeToString(newSalt),
	}, nil
}
