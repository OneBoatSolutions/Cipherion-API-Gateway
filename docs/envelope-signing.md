# Envelope signing

How device envelopes are signed and verified, and what the gateway must do to keep those signatures valid. An envelope carries a group's
data key (GDEK), wrapped for one device.

**The KMS signs and the engine verifies. The gateway only stores and delivers envelopes, and holds no signing key.**

> **Status (2026-11-07):** the gateway creates, stores and delivers envelopes through `POST /api/v1/cipseq/crypto/encrypt` and `/decrypt`. Those routes
> don't return the full agreed response yet; see [device-certificates.md](device-certificates.md#encrypt-and-decrypt).

> **Sources:** the gateway behaviour here was checked against this repository's code. The KMS and engine behaviour comes from the KMS
> team's report and docs, and wasn't checked here. The engine's source hasn't been reviewed.

## Keys

| Key | Lives in | Job |
| --- | --- | --- |
| Signing private key (P-256) | KMS only | Signs each envelope |
| Signing public key and its `kid` | Compiled into the engine | Verifies the signature |
| Device ML-KEM-1024 private key | Device only | Opens the envelope |
| Device ML-KEM-1024 public key | Gateway database (`device.publicKey`), sent to the KMS | The group key is wrapped for it |

These are separate from the [TLS pin](tls-pins.md) and the device certificate. Those protect the connection. The signature protects the
envelope itself, whichever connection delivered it.

## The flow

1. The project admin approves a device and enters the project passphrase.
2. The gateway calls `createDeviceEnvelope`, using the device's **registered** public key from the database.
3. The KMS opens the key chain, wraps the group key for that device, signs the result (a 64-byte `r||s` signature) and returns JSON.
4. The gateway stores that JSON exactly as returned, in `deviceEnvelope.envelopeJson`.
5. The gateway delivers the envelope to the device, once the session and the device certificate both pass.
6. The engine verifies the signature **before** using its private key, checking its own device ID and key hash, and then opens the group
   key.

Steps 2 to 4 are in [src/cipseq/device-envelopes.ts](../src/cipseq/device-envelopes.ts). The first envelope is created inside the approval
request, so a wrong passphrase is answered and counted there. A background job creates the rest, holding the passphrase in memory only.

## Rules for the gateway

- **Never change a value inside `envelope`.** Put any metadata beside it. Key order and whitespace don't matter, because the signature
  covers the decoded values, but a changed value breaks verification.
- **Never take the device key from a request.** It always comes from the database row made at registration.
- **Never store or log the passphrase.** It goes to the KMS and is dropped.
- **Keep envelopes out of other routes.** `GET /workspace` must not return `envelopeJson`, and
  [a test](../src/workspace/workspace.controller.spec.ts) enforces this. Encrypt and decrypt are the only way out, and both require a session and a
  device certificate.
- **Never fall back to an older key on encrypt.** While a new envelope is being created, encrypt answers `503` with `Retry-After`.

## Rotating the signing key

The order matters. The engine must trust the new `kid` first, and only then does the KMS switch to signing with it. The steps are in
`docs/engine-signing-key.md` in the KMS repository.

This doesn't change anything in the gateway, which holds neither key.

## Revocation limit

Revoking a device soft deletes its envelopes and blocks future delivery. It can't take back a group key the device already holds. Only a key
rotation cuts that device off. See [src/cipseq/revocations.ts](../src/cipseq/revocations.ts).

## Open issue: F-01

**Stored wrapped keys aren't tied to their project or group.** A compromised gateway could get the KMS to sign an envelope for a victim's
group containing a key the attacker chose. The engine would accept it, because the signature is valid.

This comes from `docs/security-audit.md` in the KMS repository, and it's **still open and needs a decision**. The fix isn't decided yet, and it
may change the KMS proto or the stored envelopes.

## Not verified here

- No engine has verified an envelope from this gateway. The e2e suite shows the delivered envelope is unchanged from what the KMS returned, but doesn't check its signature.
- The signature format, the signing key's custody and the `kid` handling are as described by the KMS team.
