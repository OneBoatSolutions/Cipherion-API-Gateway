# Device certificates: what is implemented

Status of the gateway's certificate work: KMS mutual TLS, TLS pins and device certificates. Update this page as each part is
finished. Last updated 2026-11-07, on branch `feat/certs`.

## Status

| Part | Status |
| --- | --- |
| Gateway to KMS mutual TLS | Done, tested against a local KMS |
| Wrong-passphrase fix in `toHttpException` | Done |
| Client certificate expiry check, and a daily check of all certificates | Done |
| KMS proto and generated client for `IssueDeviceCertificate` | Done, with real signing tested. See [the proto note](#proto) |
| Certificate tables | Done |
| Dev server key and TLS pin tooling (`npm run certs:engine`) | Done. Keys and rotation are in [tls-pins.md](tls-pins.md) |
| Engine listener on port 3443 | Done, off by default |
| Device identity guards | Done |
| Enrol and renew endpoints | Done |
| Bearer sessions and the 1-day session lifetime | Done |
| Revoking certificates with a device | Done |
| Encrypt and decrypt routes | **Partly done: the response is incomplete.** See [below](#encrypt-and-decrypt) |
| Workspace notice and certificate status | Done |
| Owner notice by email | **Not started**: the rows are written, but nothing sends them. Blocks production |

## How it works

```
Browser / dashboard → Traefik → gateway :3000
Engine              → published port, no proxy → gateway :3443 (gateway's own TLS)
Gateway             → KMS :50051, private network, mutual TLS
```

1. **Register:** `POST /api/v1/cipseq/devices`, with a session.
2. **Enrol:** the engine makes a P-256 key and CSR, and sends the CSR with a session to `.../devices/:deviceId/certificate`. The gateway
   asks the KMS to sign it, using the gateway's own certificate.
3. **Use:** the engine opens a **new** connection presenting its certificate, and calls encrypt or decrypt with a session.
4. **Renew:** `.../certificate/renew` with a new key and only the certificate. The old one keeps working for 24 hours.

The code is in [src/engine/](../src/engine/) (listener, identity, guards, controllers) and [src/cipseq/](../src/cipseq/)
(`device-certificates.ts`, `device-certificate-issuance.ts`, `device-lock.ts`, `envelope-delivery.ts`). The routes and their answers are in the
[README](../README.md#engine-listener).

## What protects what

| Rule | How |
| --- | --- |
| A forged certificate can't pass | `socket.authorized` must be true. The listener accepts connections without a valid certificate, so that enrolment can work, so an open connection proves nothing |
| Revocation works on existing connections | The database is checked on every request. A resumed TLS session looks fully authorized without presenting a certificate |
| Identity can't be claimed | The device always comes from the socket, never a header or body |
| The dashboard and sign-in aren't on the public port | `EngineModule` only mounts the engine routes |
| Enrolment can't happen on the console port | Same: the routes aren't mounted there |
| One current certificate per device | A partial unique index, `deviceCertificate_one_current` |
| A retired CSR can't be issued again | A unique index on `deviceId` and `csrSha256`, across history |
| Retries are safe | The KMS call is never retried. A retried CSR answers from the database, without signing |
| The KMS call holds no database connection | Two transactions around it, with every check run again in the second |
| A revocation can't lose to an enrolment in progress | Both take a per-device advisory lock |
| One device can't starve the database pool | 60 requests a minute before the lock, a 2-second lock wait, and then `503` with `Retry-After` |
| A failed limit count can't be rolled back | Refusals are returned out of the transaction and thrown after it commits |
| A stolen session can enrol, so the owner is told | A notice in `GET /workspace` that can't be turned off. **Email is still missing** |

## Where this differs from the source doc

- **Enums:** `issuedVia`, `operation` and `kind` are the Prisma enum `DeviceCertificateOperation`, not plain strings.
- **Outbox:** `deviceCertificateNotice` also has `deliveryAttempts` and `nextDeliveryAt`, so adding email needs no new migration.
- **Attempt rows:** rows past the limit's window are deleted when that device next asks, so the table stays small.
- **Refusals:** `checkCertificate()` returns a refusal instead of throwing, so the attempt row survives.
- **Extra limits:** per-device and per-IP limits in Redis, a 10-second handshake and header timeout, a connection limit, and a daily expiry check.
- **Shutdown:** `closeEngine()` closes idle connections at once and everything else after 8 seconds, because a connected client could otherwise hold up
  shutdown. Tests found this.
- **Not mounted:** `HealthModule`, because `/ready` names the gateway's dependencies.

## Proto

`proto/kms/v1/prototypeBufferV1.proto` was updated from the 18-line change in the KMS repository, not copied from the file itself. Real signing confirms
the field numbers match the running KMS. To be certain it's identical, compare it with `proto/prototypeBufferV1.proto` in the KMS repository.

## Encrypt and decrypt

The access checks are complete and tested. **The response isn't the agreed contract yet.** The contract has 11 outer fields around the signed `envelope`, and
is defined in `temp/kms-console/docs/device-certificates-api.md` in the KMS repository, which hasn't been read here. The gateway returns only the three it
knows about:

```json
{ "requestId": "...", "status": "APPROVED", "envelope": { } }
```

Don't ship these routes to an engine until the rest are added. A strict engine will reject this response, which fails safely.

Every delivery takes the device lock and writes an audit row, as the source doc says. The README says the engine asks for the envelope on every operation, so
the load should be tested before production, and the audit table will need a retention plan.

## Running it locally

```bash
npm run certs:engine
```

Then set these in `.env`, and restart the gateway. Every setting, and when it's required, is in [environment.md](environment.md).

```
DEVICE_ENGINE_ENABLED=true
DEVICE_ENGINE_HOST=127.0.0.1
DEVICE_ENGINE_PORT=3443
DEVICE_TLS_KEY=certs/engine/engine-server.key
DEVICE_TLS_CERT=certs/engine/engine-server.crt
DEVICE_TLS_PIN_FILE=certs/engine/engine-server.spki.sha256
DEVICE_CA_BUNDLE=certs/deploy/gateway/device-ca-trust.pem
```

The e2e suite needs the KMS (`make rotate-init`, `make mtls`, `make run`), both databases, Redis, OpenSSL 3.5 or later, and `certs/deploy/gateway/` in this repository:

```bash
npx vitest run --config ./vitest.config.e2e.ts test/device-certificates.e2e-spec.ts
```

## Tested

Checked with Node 22.23.2 and OpenSSL 3.5.7, against a local KMS, Postgres and Redis.

| Area | Result |
| --- | --- |
| `test/device-certificates.e2e-spec.ts` | Real TLS handshakes and real KMS signing |
| Listener | Serves the pinned key. Refuses TLS 1.2 and a classical-only key exchange. Other routes are 404, and enrol and renew are 404 on the console. Forwarded headers change nothing |
| Enrolment | New, retry and rewrapped PEM. Retiring the old certificate and its CSR. Same 404 for unknown and other people's devices. Revoked device. Bad bodies, 413, both limits. Malicious CSR gets the fixed profile. P-384 and RSA refused |
| Renewal | Certificate only. 24-hour overlap, and expiry winning over it. Same key, wrong device. A superseded certificate can retry but not start another. Limit. Owner gone |
| Certificate checks | Unknown CA refused. Revoked certificate refused on a keep-alive connection and on a resumed TLS session. Refusals audited |
| Races | Two identical enrolments: one 201, one 200, one notice. Two different renewals: one 201, one 495. A locked device gets 503, not a 500 |
| Delivery | A real signed envelope, unchanged. Session alone, certificate alone and another user all refused. 503 while not ready, and no older version. Group removal stops delivery but keeps the certificate |
| Start-up | Mismatched key, wrong pin, and a bad bundle all refuse to start. The built gateway boots with the listener on, `/ready` is up, and the live pin matches |
| Existing suites | All e2e and unit suites pass. `test/cipseq-devices.e2e-spec.ts` now gets its ML-KEM keys from OpenSSL, because Node 22 can't generate them |

## Not verified yet

- **In-flight requests at shutdown:** idle and silent clients are tested, but not a request finishing while the shared clients wait.
- **Revocation during the KMS call:** tested only by running the two together a few times, with varied timing. It shows no active certificate survives, but can't guarantee that exact moment was hit.
- **Expired certificate at start-up:** the logic is unit tested, but not with a real expired file.
- **KMS down, or a wrong gateway certificate, on the certificate routes:** the mapping is unit tested, but not against a real outage.
- **Real wrong-passphrase wording:** the e2e devices suite does exercise wrong passphrases against this KMS, but the attempt count isn't asserted for a refused gateway certificate.
- **Certificates from old, current and new CAs:** only the CA currently signing has been used.
- **Deployment:** no Coolify or Traefik, no firewall limit, and no real engine.
- **Load:** no load test of the lock and audit write on every delivery.
