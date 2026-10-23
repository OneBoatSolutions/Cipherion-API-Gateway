package callbackHandler

// End-to-end tests of the key hierarchy, calling the handlers the way the gateway does:
//
//	Cipherion Root Key ──wraps──▶ Project Root Key (PRK)
//	PRK + passphrase ──derive──▶ wrapping key ──wraps──▶ Project Encryption Key (PEK)
//	PEK ──wraps──▶ Group Root Key (GRK) ──wraps──▶ Group Data Encryption Key (GDEK)
//
// The derivation recipe is written out again here on purpose, independent of the handler's
// helpers, so these tests also pin down the on-disk format that stored keys depend on.

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"cipsec/services/core/cryptography/aesgcm"
	"cipsec/services/core/cryptography/kdf"
	"cipsec/services/core/cryptography/pbkdf"
	pb "cipsec/services/core/generated/v1"
)

const (
	passA = "correct horse battery staple"
	passB = "a completely different passphrase"
)

// wrappingKeyFor is the documented recipe: HKDF(PRK || PBKDF2(passphrase, salt), salt, info).
func wrappingKeyFor(t *testing.T, prk []byte, passphrase string, salt []byte) []byte {
	t.Helper()
	stretched, err := pbkdf.DeriveKey(passphrase, salt)
	if err != nil {
		t.Fatal(err)
	}
	ikm := append(append([]byte{}, prk...), stretched...)
	key, err := kdf.DeriveHKDFKey(ikm, salt, []byte("cipsec/v1/kdf"))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// project holds what the gateway would have stored for one project.
type project struct {
	root *pb.CreateAndWrapNewProjectRootKey_Response
	enc  *pb.CreateAndWrapNewProjectEncryptionKey_Response
}

func newInitializedProject(t *testing.T, s *Service, passphrase string) project {
	t.Helper()
	ctx := context.Background()
	root, err := s.CreateAndWrapNewProjectRootKey(ctx, &pb.CreateAndWrapNewProjectRootKey_Request{ProjectId: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	enc, err := s.CreateAndWrapNewProjectEncryptionKey(ctx, &pb.CreateAndWrapNewProjectEncryptionKey_Request{
		ProjectId:                "p1",
		WrappedProjectRootKeyIV:  root.WrappedProjectRootKeyIV,
		WrappedProjectRootKey:    root.WrappedProjectRootKey,
		WrappedProjectRootKeyTag: root.WrappedProjectRootKeyTag,
		UserPassphrase:           passphrase,
	})
	if err != nil {
		t.Fatalf("initialize project: %v", err)
	}
	return project{root: root, enc: enc}
}

func groupRequest(p project, passphrase string) *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request {
	return &pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request{
		GroupId:                        "g1",
		WrappedProjectRootKeyIV:        p.root.WrappedProjectRootKeyIV,
		WrappedProjectRootKey:          p.root.WrappedProjectRootKey,
		WrappedProjectRootKeyTag:       p.root.WrappedProjectRootKeyTag,
		WrappedProjectEncryptionKeyIV:  p.enc.WrappedProjectEncryptionKeyIV,
		WrappedProjectEncryptionKey:    p.enc.WrappedProjectEncryptionKey,
		WrappedProjectEncryptionKeyTag: p.enc.WrappedProjectEncryptionKeyTag,
		UserPassphrase:                 passphrase,
		UserPassphraseSalt:             p.enc.UserPassphraseSalt,
	}
}

func rotateRequest(p project, current, next string) *pb.RotateWrappingKeyforProjectEncryptionKey_Request {
	return &pb.RotateWrappingKeyforProjectEncryptionKey_Request{
		ProjectId:                             "p1",
		CurrentUserPassphrase:                 current,
		CurrentUserPassphraseSalt:             p.enc.UserPassphraseSalt,
		NewUserPassphrase:                     next,
		CurrentWrappedProjectRootKeyIV:        p.root.WrappedProjectRootKeyIV,
		CurrentWrappedProjectRootKey:          p.root.WrappedProjectRootKey,
		CurrentWrappedProjectRootKeyTag:       p.root.WrappedProjectRootKeyTag,
		CurrentWrappedProjectEncryptionKeyIV:  p.enc.WrappedProjectEncryptionKeyIV,
		CurrentWrappedProjectEncryptionKey:    p.enc.WrappedProjectEncryptionKey,
		CurrentWrappedProjectEncryptionKeyTag: p.enc.WrappedProjectEncryptionKeyTag,
	}
}

// afterRotation is the project as the gateway would store it once rotation succeeded.
func afterRotation(p project, r *pb.RotateWrappingKeyforProjectEncryptionKey_Response) project {
	return project{
		root: p.root,
		enc: &pb.CreateAndWrapNewProjectEncryptionKey_Response{
			ProjectId:                      p.enc.ProjectId,
			WrappedProjectEncryptionKeyIV:  r.NewWrappedProjectEncryptionKeyIV,
			WrappedProjectEncryptionKey:    r.NewWrappedProjectEncryptionKey,
			WrappedProjectEncryptionKeyTag: r.NewWrappedProjectEncryptionKeyTag,
			UserPassphraseSalt:             r.NewUserPassphraseSalt,
		},
	}
}

// unwrapPEK walks the hierarchy with the independent recipe and returns the project encryption key.
func unwrapPEK(t *testing.T, rootKey []byte, p project, passphrase string) ([]byte, error) {
	t.Helper()
	prk, err := aesgcm.Decrypt(p.root.WrappedProjectRootKeyIV, p.root.WrappedProjectRootKey, p.root.WrappedProjectRootKeyTag, rootKey)
	if err != nil {
		t.Fatalf("unwrap PRK: %v", err)
	}
	salt, err := base64.StdEncoding.DecodeString(p.enc.UserPassphraseSalt)
	if err != nil || len(salt) != pbkdf.SaltSize {
		t.Fatalf("salt must be %d base64 bytes, got err=%v len=%d", pbkdf.SaltSize, err, len(salt))
	}
	return aesgcm.Decrypt(p.enc.WrappedProjectEncryptionKeyIV, p.enc.WrappedProjectEncryptionKey, p.enc.WrappedProjectEncryptionKeyTag,
		wrappingKeyFor(t, prk, passphrase, salt))
}

func wantCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if got := status.Code(err); got != want {
		t.Fatalf("got code %v (err=%v), want %v", got, err, want)
	}
}

func TestInitializeProjectWrapsAKeyOnlyThePassphraseCanOpen(t *testing.T) {
	s, rootKey := newTestService(t)
	p := newInitializedProject(t, s, passA)

	pek, err := unwrapPEK(t, rootKey, p, passA)
	if err != nil || len(pek) != aesgcm.KeySize {
		t.Fatalf("correct passphrase must unwrap a 32-byte key: err=%v len=%d", err, len(pek))
	}
	if _, err := unwrapPEK(t, rootKey, p, passB); err == nil {
		t.Fatal("a wrong passphrase must not unwrap the project encryption key")
	}
}

func TestInitializeProjectRejectsBadInput(t *testing.T) {
	s, _ := newTestService(t)
	root, err := s.CreateAndWrapNewProjectRootKey(context.Background(), &pb.CreateAndWrapNewProjectRootKey_Request{ProjectId: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	good := func() *pb.CreateAndWrapNewProjectEncryptionKey_Request {
		return &pb.CreateAndWrapNewProjectEncryptionKey_Request{
			ProjectId: "p1", UserPassphrase: passA,
			WrappedProjectRootKeyIV: root.WrappedProjectRootKeyIV, WrappedProjectRootKey: root.WrappedProjectRootKey, WrappedProjectRootKeyTag: root.WrappedProjectRootKeyTag,
		}
	}
	cases := map[string]func(*pb.CreateAndWrapNewProjectEncryptionKey_Request){
		"missing project id": func(r *pb.CreateAndWrapNewProjectEncryptionKey_Request) { r.ProjectId = "" },
		"empty passphrase":   func(r *pb.CreateAndWrapNewProjectEncryptionKey_Request) { r.UserPassphrase = "" },
		"tampered root key": func(r *pb.CreateAndWrapNewProjectEncryptionKey_Request) {
			r.WrappedProjectRootKeyTag = r.WrappedProjectRootKeyIV
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := good()
			mutate(r)
			_, err := s.CreateAndWrapNewProjectEncryptionKey(context.Background(), r)
			wantCode(t, err, codes.InvalidArgument)
		})
	}
}

func TestCreateGroupWrapsTheWholeChain(t *testing.T) {
	s, rootKey := newTestService(t)
	p := newInitializedProject(t, s, passA)

	g, err := s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(context.Background(), groupRequest(p, passA))
	if err != nil {
		t.Fatal(err)
	}
	if g.GroupId != "g1" {
		t.Fatalf("GroupId = %q", g.GroupId)
	}

	pek, err := unwrapPEK(t, rootKey, p, passA)
	if err != nil {
		t.Fatal(err)
	}
	grk, err := aesgcm.Decrypt(g.WrappedGroupRootKeyIV, g.WrappedGroupRootKey, g.WrappedGroupRootKeyTag, pek)
	if err != nil || len(grk) != aesgcm.KeySize {
		t.Fatalf("group root key must unwrap with the project encryption key: err=%v len=%d", err, len(grk))
	}
	gdek, err := aesgcm.Decrypt(g.WrappedGroupDataEncryptionKeyIV, g.WrappedGroupDataEncryptionKey, g.WrappedGroupDataEncryptionKeyTag, grk)
	if err != nil || len(gdek) != aesgcm.KeySize {
		t.Fatalf("group data key must unwrap with the group root key: err=%v len=%d", err, len(gdek))
	}
	if bytes.Equal(grk, gdek) {
		t.Fatal("group root key and group data key must be different keys")
	}
}

// The dangerous case: a wrong passphrase must be an error. If it is ignored, the handler
// would return empty "wrapped" values and the gateway would store them, losing the group.
func TestCreateGroupWithWrongPassphraseIsRefused(t *testing.T) {
	s, _ := newTestService(t)
	p := newInitializedProject(t, s, passA)

	g, err := s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(context.Background(), groupRequest(p, passB))
	wantCode(t, err, codes.PermissionDenied)
	if g != nil {
		t.Fatalf("no keys may be returned for a wrong passphrase, got %+v", g)
	}
}

func TestCreateGroupRejectsBadInput(t *testing.T) {
	s, _ := newTestService(t)
	p := newInitializedProject(t, s, passA)
	cases := map[string]func(*pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request){
		"missing group id": func(r *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) { r.GroupId = "" },
		"empty passphrase": func(r *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) { r.UserPassphrase = "" },
		"malformed salt": func(r *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) {
			r.UserPassphraseSalt = "not base64!"
		},
		"salt of wrong size": func(r *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) {
			r.UserPassphraseSalt = "AAAA"
		},
		"tampered root key": func(r *pb.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey_Request) {
			r.WrappedProjectRootKeyTag = r.WrappedProjectRootKeyIV
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := groupRequest(p, passA)
			mutate(r)
			_, err := s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(context.Background(), r)
			wantCode(t, err, codes.InvalidArgument)
		})
	}
}

func TestRotateWrappingKeyMovesTheSameKeyToTheNewPassphrase(t *testing.T) {
	s, rootKey := newTestService(t)
	p := newInitializedProject(t, s, passA)
	before, err := unwrapPEK(t, rootKey, p, passA)
	if err != nil {
		t.Fatal(err)
	}

	r, err := s.RotateWrappingKeyforProjectEncryptionKey(context.Background(), rotateRequest(p, passA, passB))
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if r.NewUserPassphraseSalt == "" || r.NewUserPassphraseSalt == p.enc.UserPassphraseSalt {
		t.Fatalf("rotation must return a NEW salt (old=%q new=%q)", p.enc.UserPassphraseSalt, r.NewUserPassphraseSalt)
	}
	rotated := afterRotation(p, r)

	after, err := unwrapPEK(t, rootKey, rotated, passB)
	if err != nil {
		t.Fatalf("the NEW passphrase must open the rotated key: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("rotation must re-wrap the SAME project encryption key, not create a new one")
	}
	if _, err := unwrapPEK(t, rootKey, rotated, passA); err == nil {
		t.Fatal("the OLD passphrase must no longer open the rotated key")
	}
}

// Groups created before a rotation stay valid (they hang off the PEK, which did not change),
// and new groups work with the new passphrase only.
func TestGroupsKeepWorkingAcrossARotation(t *testing.T) {
	s, _ := newTestService(t)
	ctx := context.Background()
	p := newInitializedProject(t, s, passA)
	old, err := s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(ctx, groupRequest(p, passA))
	if err != nil {
		t.Fatal(err)
	}

	r, err := s.RotateWrappingKeyforProjectEncryptionKey(ctx, rotateRequest(p, passA, passB))
	if err != nil {
		t.Fatal(err)
	}
	rotated := afterRotation(p, r)

	if _, err := s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(ctx, groupRequest(rotated, passB)); err != nil {
		t.Fatalf("new passphrase must create groups: %v", err)
	}
	_, err = s.CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey(ctx, groupRequest(rotated, passA))
	wantCode(t, err, codes.PermissionDenied)

	if old.WrappedGroupRootKey == "" {
		t.Fatal("pre-rotation group must still hold its wrapped keys")
	}
}

func TestRotateWithWrongCurrentPassphraseIsRefused(t *testing.T) {
	s, _ := newTestService(t)
	p := newInitializedProject(t, s, passA)
	r, err := s.RotateWrappingKeyforProjectEncryptionKey(context.Background(), rotateRequest(p, passB, "something else entirely"))
	wantCode(t, err, codes.PermissionDenied)
	if r != nil {
		t.Fatalf("no keys may be returned when the current passphrase is wrong, got %+v", r)
	}
}

func TestRotateRejectsBadInput(t *testing.T) {
	s, _ := newTestService(t)
	p := newInitializedProject(t, s, passA)
	cases := map[string]func(*pb.RotateWrappingKeyforProjectEncryptionKey_Request){
		"missing project id": func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) { r.ProjectId = "" },
		"empty current":      func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) { r.CurrentUserPassphrase = "" },
		"empty new":          func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) { r.NewUserPassphrase = "" },
		"new equals current": func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) { r.NewUserPassphrase = passA },
		"malformed salt":     func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) { r.CurrentUserPassphraseSalt = "!!" },
		"tampered wrapped PEK": func(r *pb.RotateWrappingKeyforProjectEncryptionKey_Request) {
			r.CurrentWrappedProjectEncryptionKeyTag = r.CurrentWrappedProjectEncryptionKeyIV
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := rotateRequest(p, passA, passB)
			mutate(r)
			_, err := s.RotateWrappingKeyforProjectEncryptionKey(context.Background(), r)
			if name == "tampered wrapped PEK" {
				wantCode(t, err, codes.PermissionDenied) // indistinguishable from a wrong passphrase, by design
				return
			}
			wantCode(t, err, codes.InvalidArgument)
		})
	}
}
