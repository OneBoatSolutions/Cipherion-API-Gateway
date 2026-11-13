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
| `EMAIL_HOST` | `localhost` | SMTP server for verification, password reset and password changed emails. Not required when `NODE_ENV=test` |
| `EMAIL_PORT` | `1025` | `465` uses TLS from the start, other ports upgrade with STARTTLS. **Production:** the connection must use TLS. Not required when `NODE_ENV=test` |
| `EMAIL_FROM` | `Cipherion <no-reply@cipherion.com>` | Sender of those emails. Most providers only send as the login's own address. Not required when `NODE_ENV=test` |
| `KMS_ADDRESS` | `localhost:50051` | KMS as `host:port`. The host must be a name inside the KMS's `server.crt`: `localhost`, `cipherion-kms` or `127.0.0.1` by default |
| `KMS_CA_CERT` | `certs/deploy/gateway/ca.crt` | Transport CA bundle, which checks the KMS |
| `KMS_CLIENT_CERT` | `certs/deploy/gateway/gateway.crt` | The gateway's client certificate. Start-up fails if it has expired, and warns under 30 days |
| `KMS_CLIENT_KEY` | `certs/deploy/gateway/gateway.key` | **Secret.** Its private key |

The three KMS files come from `certs/deploy/gateway/` after `make setup-all` in the KMS repository (`D:\OneBoatSolutions\servers\Cipherion-KMS`). There's no plaintext mode, so they're required even
locally.

## Optional

| Setting | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production also hides the API docs and turns on secure cookies |
| `PORT` | `3000` | Console port: dashboard, auth and CipSeq routes. Behind Traefik in production |
| `DATABASE_CA_CERT` | – | PEM file of CAs to trust for both databases' TLS certificates, when a private CA signed them. See [Private CAs](#private-cas-for-the-databases-and-redis) |
| `REDIS_CA_CERT` | – | The same for Redis, `rediss://` only. Can point at the same file |
| `EMAIL_USER`, `EMAIL_PASS` | – | SMTP login, both or neither. Leave out for Mailpit. `EMAIL_PASS` is **secret** |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | Google sign-in, on when both are set. Redirect URI: `<BETTER_AUTH_URL>/api/v1/auth/callback/google` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | – | GitHub sign-in, on when both are set. Redirect URI: `<BETTER_AUTH_URL>/api/v1/auth/callback/github` |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | – | NestJS Observe telemetry. Without them, nothing is sent |

## Private CAs for the databases and Redis

A database or Redis whose certificate a **private** CA signed (self-hosted, or a platform such as Coolify, which has its own CA) isn't trusted by default, and
the gateway fails at start-up with `unable to verify the first certificate` or `SELF_SIGNED_CERT_IN_CHAIN`. Give it the CA, as a file:

```
DATABASE_CA_CERT=/certs/database-ca.pem
REDIS_CA_CERT=/certs/database-ca.pem
```

- The files are not tied to a host. Moving to another host or provider changes the **file**, never the code: put that provider's CA in the file, or unset
  the setting when a public CA signs the certificate (most managed databases, which also publish a CA bundle if they don't).
- The file may hold **several** CAs. Before a CA expires, add the new one **next to** the old one, restart, and remove the old one later. Check when one ends with
  `openssl x509 -enddate -noout -in <file>` (for a bundle, run it on each certificate).
- The certificate and its host name are always verified. The URL's host must be a name in the database's certificate.
- While `DATABASE_CA_CERT` is set, the `sslmode` in the URL is ignored. Leave it out, or use `sslmode=disable` to turn TLS off for a database on a trusted private network.
- `NODE_EXTRA_CA_CERTS` also works for the databases, but it trusts the CA for every connection the process makes. Prefer these settings.
- Migrations (`npm run db:deploy`) are run by Prisma's own tool, which reads the URL's `sslmode` and not these settings.

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

The certificate files are made in the KMS repository (`D:\OneBoatSolutions\servers\Cipherion-KMS`), not here. This copies them into this
repository's `certs/` folder (`certs/deploy/gateway/` for the KMS connection, the device CA bundle and the engine listener):

```bash
cd D:\OneBoatSolutions\servers\Cipherion-KMS
make setup-all            # once: makes every key and certificate
make local-gateway GATEWAY_DIR=D:/OneBoatSolutions/servers/Cipherion-API_Gateway
```

Without `GATEWAY_DIR`, the command only makes the folder `D:\OneBoatSolutions\servers\Cipherion-KMS\certs\deploy\local-gateway\`; copy its contents into
this repository's `certs/` folder yourself. The engine certificate is made for `localhost` and `127.0.0.1`; for another name set `ENGINE_HOSTS` in the KMS `.env`
before the first `make setup-all`. The full explanation is `docs/local-gateway-testing.md` in the KMS repository.

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
DEVICE_TLS_KEY=certs/deploy/gateway/engine-server.key
DEVICE_TLS_CERT=certs/deploy/gateway/engine-server.crt
DEVICE_TLS_PIN_FILE=certs/deploy/gateway/engine-server.spki.sha256
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

### Certificate files on Coolify

On the server, put the files from `D:\OneBoatSolutions\servers\Cipherion-KMS\certs\deploy\gateway\` in `/data/cipherion/gateway/`
(owner UID 1000, the image's `node` user, with `chmod 400` on the `.key` files) and add a read-only bind mount in Coolify: source
`/data/cipherion/gateway`, destination `/certs`. Then set `KMS_CA_CERT=/certs/ca.crt`, `KMS_CLIENT_CERT=/certs/gateway.crt`,
`KMS_CLIENT_KEY=/certs/gateway.key`, `DEVICE_TLS_KEY=/certs/engine-server.key`, `DEVICE_TLS_CERT=/certs/engine-server.crt`,
`DEVICE_TLS_PIN_FILE=/certs/engine-server.spki.sha256` and `DEVICE_CA_BUNDLE=/certs/device-ca-trust.pem`. After a rotation, replace the
files and **restart**; the full routine is `docs/coolify-certificate-routine.md` in the KMS repository.

### Migrations on Coolify

The image's entrypoint (`scripts/entrypoint.sh`) applies both databases' migrations on every start, then starts the gateway, so a deploy needs
no terminal step. Optional settings: `SKIP_MIGRATIONS=true` skips them, and `MIGRATE_ATTEMPTS` (default 5) and `MIGRATE_RETRY_SECONDS`
(default 5) set how long it waits for a database that's still starting. It exits `20` (auth database) or `21` (CipSeq) if migrations keep
failing, and Coolify restarts it.

Secret files: `KMS_CLIENT_KEY` and `DEVICE_TLS_KEY`. Never put a CA private key, `device-ca.key`, the KMS's `server.key` or a spare server key on the
gateway.
