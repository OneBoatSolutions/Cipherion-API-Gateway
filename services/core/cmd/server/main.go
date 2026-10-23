// Command server is the core (business logic) service. It exposes a gRPC API
// and is stateless: it has no database. The gateway loads whatever data an
// operation needs, sends it in the request, and stores whatever the reply says
// to store. It knows nothing about HTTP, sessions or the gateway.
package main

import (
	"context"
	"crypto/fips140"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	// Blank import: loads a local .env file into the environment on startup.
	_ "github.com/joho/godotenv/autoload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	"cipsec/services/core/cryptography/aesgcm"
	prototypeBufferV1 "cipsec/services/core/generated/v1"
	callbackHandler "cipsec/services/core/internal"
)

func main() {

	fmt.Println("FIPS mode enabled:", fips140.Enabled())
	fmt.Println("FIPS module version:", fips140.Version())

	// ctx is cancelled on Ctrl+C or SIGTERM, which triggers a graceful shutdown below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("GRPC_ADDR")
	if addr == "" {
		addr = ":50051"
	}
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}

	srv := grpc.NewServer()

	// The Cipherion Root Key wraps every project key. It comes from the environment
	// (a secret manager in production), is base64 of 32 random bytes, and must never
	// be committed or logged. Generate one with: openssl rand -base64 32
	rootKey, err := base64.StdEncoding.DecodeString(os.Getenv("CIPHERION_ROOT_KEY"))
	if err != nil {
		log.Fatalf("CIPHERION_ROOT_KEY must be base64: %v", err)
	}
	kmsSvc, err := callbackHandler.NewService(rootKey) // also fails if the key is not 32 bytes
	if err != nil {
		log.Fatalf("CIPHERION_ROOT_KEY: %v", err)
	}
	// This line connects incoming gRPC calls for grpcCallBackfromNest to our handler.
	// Without it every call to the service returns Unimplemented.
	prototypeBufferV1.RegisterGrpcCallBackfromNestServer(srv, kmsSvc)

	// To add another service: register its handler here the same way.
	// See docs/ADDING-A-FEATURE.md.

	// Standard health-check service, for load balancers and orchestrators.
	grpc_health_v1.RegisterHealthServer(srv, health.NewServer())
	// Reflection lets tools like grpcurl discover the API without the .proto file.
	// Consider disabling it in production.
	reflection.Register(srv)

	// On shutdown signal, stop accepting new calls and let in-flight ones finish.
	go func() {
		<-ctx.Done()
		srv.GracefulStop()
	}()
	log.Printf("core listening on %s", addr)
	// Serve blocks until GracefulStop is called.
	if err := srv.Serve(lis); err != nil {
		log.Fatal(err)
	}
}

func test() {

	// Usage : AES-256GCM
	// Demo only: generate a key for this example.
	// In production, load an existing securely stored key.
	key := make([]byte, aesgcm.KeySize)
	if _, err := rand.Read(key); err != nil {
		log.Fatal(err)
	}

	plaintext := []byte("Sensitive customer information")

	iv, ciphertext, tag, err := aesgcm.Encrypt(plaintext, key)
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println("Encrypted:", iv, ciphertext, tag)

	decrypted, err := aesgcm.Decrypt(iv, ciphertext, tag, key)
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println("Decrypted:", string(decrypted))
	fmt.Println("Key (demo only):", base64.StdEncoding.EncodeToString(key))
}
