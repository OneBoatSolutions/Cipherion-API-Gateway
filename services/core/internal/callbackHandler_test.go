package callbackHandler

import (
	"bytes"
	"context"
	"crypto/rand"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"cipsec/services/core/cryptography/aesgcm"
	prototypeBufferV1 "cipsec/services/core/generated/v1"
)

func newTestService(t *testing.T) (*Service, []byte) {
	t.Helper()
	rootKey := make([]byte, aesgcm.KeySize)
	if _, err := rand.Read(rootKey); err != nil {
		t.Fatal(err)
	}
	s, err := NewService(rootKey)
	if err != nil {
		t.Fatal(err)
	}
	return s, rootKey
}

func TestNewServiceRejectsBadRootKey(t *testing.T) {
	if _, err := NewService(make([]byte, 16)); err == nil {
		t.Fatal("a 16-byte root key must be rejected")
	}
}

// The wrapped key must unwrap, with the root key, to a 32-byte key, and each call must produce a new one.
func TestCreateAndWrapRoundTrip(t *testing.T) {
	s, rootKey := newTestService(t)
	req := &prototypeBufferV1.CreateAndWrapNewProjectRootKey_Request{ProjectId: "p1"}

	first, err := s.CreateAndWrapNewProjectRootKey(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if first.ProjectId != "p1" {
		t.Fatalf("projectId = %q, want p1", first.ProjectId)
	}
	prk, err := aesgcm.Decrypt(first.WrappedProjectRootKeyIV, first.WrappedProjectRootKey, first.WrappedProjectRootKeyTag, rootKey)
	if err != nil || len(prk) != aesgcm.KeySize {
		t.Fatalf("unwrap failed: err=%v len=%d", err, len(prk))
	}

	second, err := s.CreateAndWrapNewProjectRootKey(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	prk2, _ := aesgcm.Decrypt(second.WrappedProjectRootKeyIV, second.WrappedProjectRootKey, second.WrappedProjectRootKeyTag, rootKey)
	if bytes.Equal(prk, prk2) {
		t.Fatal("two calls returned the same project key")
	}
}

func TestCreateAndWrapRequiresProjectID(t *testing.T) {
	s, _ := newTestService(t)
	_, err := s.CreateAndWrapNewProjectRootKey(context.Background(), &prototypeBufferV1.CreateAndWrapNewProjectRootKey_Request{})
	if got := status.Code(err); got != codes.InvalidArgument {
		t.Fatalf("got %v, want InvalidArgument", got)
	}
}
