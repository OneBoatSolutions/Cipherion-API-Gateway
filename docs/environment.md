# Environment settings

Every setting the gateway reads, what each one is for, and when it's required. The gateway checks them at start-up and refuses to start
if a required one is missing or invalid. [.env.example](../.env.example) has the same list, ready to copy.

## Where settings come from

- The gateway loads `.env` if it exists, otherwise `.env.prod` when `NODE_ENV=production`, otherwise `.env.dev`.
- Settings already set by the host, such as Coolify, are never overwritten by the file.
- Prisma commands load `.env.dev`, `.env.test` or `.env.prod` by `NODE_ENV`, and never `.env`. Keep the database settings the same in both files
  when developing locally.
- Every file is read only at start-up, so **any change needs a restart**. That includes replacing a certificate or key file.
- Never commit `.env`, `.env.dev` or `.env.prod`, or anything in `certs/`.

## Required in every environment

| Setting | Example | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://…/cipherion_gateway` | Auth database (users, sessions, settings) |
| `CIPSEQ_DATABASE_URL` | `postgresql://…/cipherion_cipseq` | CipSeq database. **Production:** must be a different database from `DATABASE_URL` |
| `BETTER_AUTH_SECRET` | 32+ random characters | **Secret.** Signs sessions and bearer tokens |
| `BETTER_AUTH_URL` | `http://localhost:3001` | The gateway's public URL |
| `AUTH_TRUSTED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to call the console port, such as the dashboard |
| `REDIS_URL` | `redis://localhost:6379` | Sessions, rate limits and request limits. **Production:** must be `rediss://` |
| `KMS_ADDRESS` | `localhost:50051` | KMS as `host:port`. The host must be a name inside the KMS's `server.crt`: `localhost`, `cipherion-kms` or `127.0.0.1` by default |
| `KMS_CA_CERT` | `certs/deploy/gateway/ca.crt` | Transport CA bundle, which checks the KMS |
| `KMS_CLIENT_CERT` | `certs/deploy/gateway/gateway.crt` | The gateway's client certificate. Start-up fails if it has expired, and warns under 30 days |
| `KMS_CLIENT_KEY` | `certs/deploy/gateway/gateway.key` | **Secret.** Its private key |

The three KMS files come from `certs/deploy/gateway/` after `make rotate-init` in the KMS repository. There's no plaintext mode, so they're required even
locally.

## Optional

| Setting | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production also hides the API docs and turns on secure cookies |
| `PORT` | `3000` | Console port: dashboard, auth and CipSeq routes. Behind Traefik in production |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | – | NestJS Observe telemetry. Without them, nothing is sent |

## Engine listener (port 3443)

The engine's own TLS port, for enrol, renew, encrypt and decrypt. See [tls-pins.md](tls-pins.md) and [device-certificates.md](device-certificates.md).

| Setting | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DEVICE_ENGINE_ENABLED` | No | `false` | `true` starts the listener. `false` closes the port, but nothing turns the certificate checks off |
| `DEVICE_ENGINE_HOST` | No | `0.0.0.0` | `127.0.0.1` for local only, `0.0.0.0` to accept other machines or in a container |
| `DEVICE_ENGINE_PORT` | No | `3443` | Must differ from `PORT` |
| `DEVICE_TLS_KEY` | **When enabled** | – | **Secret.** Private key of the **active** server key. Never the spare |
| `DEVICE_TLS_CERT` | **When enabled** | – | Its self-signed certificate |
| `DEVICE_TLS_PIN_FILE` | **When enabled** | – | The active pin. Start-up fails if the key doesn't hash to it |
| `DEVICE_CA_BUNDLE` | **When enabled** | – | `device-ca-trust.pem`, holding every device CA currently in a slot. Checks device certificates |

When enabled, start-up also fails if the key and certificate don't match, the bundle holds no certificates or anything other than CAs, or Node's OpenSSL
lacks the `SecP256r1MLKEM768` key exchange (it needs OpenSSL 3.5 or later).

### Two files that look alike

| File | Setting | Checks |
| --- | --- | --- |
| `ca.crt` | `KMS_CA_CERT` | The KMS, on the gateway-to-KMS connection |
| `device-ca-trust.pem` | `DEVICE_CA_BUNDLE` | Device certificates, on port 3443 |

Neither fails at start-up if swapped. Swapped, every KMS call fails, and no device certificate is accepted.

## Local setup

```bash
npm run certs:engine
```

Then, in `.env`:

```
PORT=3001
BETTER_AUTH_URL=http://localhost:3001

KMS_ADDRESS=localhost:50051
KMS_CA_CERT=certs/deploy/gateway/ca.crt
KMS_CLIENT_CERT=certs/deploy/gateway/gateway.crt
KMS_CLIENT_KEY=certs/deploy/gateway/gateway.key

DEVICE_ENGINE_ENABLED=true
DEVICE_ENGINE_HOST=127.0.0.1
DEVICE_ENGINE_PORT=3443
DEVICE_TLS_KEY=certs/engine/engine-server.key
DEVICE_TLS_CERT=certs/engine/engine-server.crt
DEVICE_TLS_PIN_FILE=certs/engine/engine-server.spki.sha256
DEVICE_CA_BUNDLE=certs/deploy/gateway/device-ca-trust.pem
```

Restart the gateway, and look for `Engine listener is running on port 3443` in the log. `PORT=3001` here avoids the dashboard, which runs on 3000.

## Production

| Setting | Requirement |
| --- | --- |
| `NODE_ENV` | `production` |
| `REDIS_URL` | `rediss://` |
| `CIPSEQ_DATABASE_URL` | A different database from `DATABASE_URL` |
| `KMS_ADDRESS` | `cipherion-kms:50051`, on the private network. The KMS port must not be published |
| `DEVICE_ENGINE_HOST` | `0.0.0.0` |
| `DEVICE_TLS_*` | Key **A** only, from a secret mount, readable only by the gateway's user |
| Port 3443 | Published directly, never through Traefik, with a firewall connection limit |

Secret files: `KMS_CLIENT_KEY` and `DEVICE_TLS_KEY`. Never put a CA private key, `device-ca.key`, the KMS's `server.key` or a spare server key on the
gateway.
