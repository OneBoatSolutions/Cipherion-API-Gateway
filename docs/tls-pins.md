# TLS pins

How the gateway's TLS pins are generated, delivered, checked and rotated. For anyone operating the gateway or releasing the engine.

> **Status (2026-11-07):** the engine listener, its start-up checks and its key tooling (now in the KMS repository) are built and tested locally. It hasn't
> been deployed behind a real Coolify setup or used by a real engine; see [what was tested](#what-was-tested).

## What a pin is

The engine (the program on each device) talks to the gateway on port 3443. Before it sends any bytes, it checks that the server's
public key hashes to a value compiled into the engine. That value is the pin:

```
pin = Base64( SHA-256( DER SubjectPublicKeyInfo of the gateway's HTTPS server key ) )
```

It's 32 bytes, written as 44 Base64 characters, with no `sha256/` prefix.

- **It hashes the key, not the certificate.** The certificate can be renewed without changing the pin.
- **It proves one thing:** to the engine, "this really is our gateway". No CA or KMS call is involved.
- **It's public.** It isn't a secret, but the engine must never learn it from a network response. It only arrives through the engine's
  reviewed build.

Don't confuse it with these:

| Value | What it is | Used for |
| --- | --- | --- |
| **TLS pin** | Hash of the gateway's server key | The engine checks the gateway |
| `publicKeySha256` | Hash of a **device's** TLS key, in hex | The gateway checks a device certificate |
| `device-ca-trust.pem` | CAs that sign device certificates | The gateway checks a device certificate |
| `ca.crt` | CAs for the gateway-to-KMS link | The gateway and the KMS check each other |

## Port 3443 must bypass Traefik

Traefik ends TLS on the public domain with its own Let's Encrypt key. An engine going through it would see Traefik's key, so the pin
would never match, and that key can change at any renewal.

```
Browser / dashboard → https://api.example.com → Traefik (Let's Encrypt) → gateway :3000
Engine              → engine.example.com:3443 → published port, no proxy → gateway :3443 (gateway's own TLS)
```

In Coolify, publish `3443:3443` directly and keep the domain pointing at 3000. The pin files live in `/data/cipherion/gateway/` on the server (see
`docs/environment.md`, "Certificate files on Coolify"). Confirm this on staging, using
[the live check](#check-the-live-server), **before** any pin ships in an engine.

## The two keys

The engine compiles in **two** pins, so the server key can change without locking out installed engines.

| Key | Private key lives | Public values go |
| --- | --- | --- |
| **A**, active | Gateway secret mount, nowhere else on the server | Certificate on the gateway, pin in the engine |
| **B**, spare | **Offline**, in encrypted custody with named custodians. Never on the gateway or in CI | Certificate and pin on release systems, pin in the engine |

The two pins must differ. Each environment has its own keys, and development pins must never reach a production engine.

## Generating keys and pins

Run this on the admin machine, once per key, using the real host name of the engine endpoint. Self-signed is correct here, because the
engine trusts the pin and not a CA.

**The KMS repository makes the keys for you.** It creates the active key (A) and the spare (B) together, never replaces an existing key, refuses a pin
file that doesn't match, and records both pins in `pins.json` for the engine team. Run it in `D:\OneBoatSolutions\servers\Cipherion-KMS`:

```bash
ENGINE_HOSTS=engine.example.com make setup-all     # the real host name of the engine endpoint (default: localhost,127.0.0.1)
make pin-status                                    # shows both pins and when the certificate ends
```

The files for the gateway are then in `D:\OneBoatSolutions\servers\Cipherion-KMS\certs\deploy\gateway\` (`engine-server.key`, `engine-server.crt`,
`engine-server.spki.sha256`), and the pins for the engine team are in `...\certs\deploy\engine\pins.json`. For local testing run
`make local-gateway GATEWAY_DIR=D:/OneBoatSolutions/servers/Cipherion-API_Gateway`; for a server run `make server-push SERVER=user@host`. Both are explained in
`docs/local-gateway-testing.md` and `docs/coolify-certificate-routine.md` in the KMS repository. Then do [step 3](#3-check-the-pin-before-using-it) and
[step 4](#4-store-the-spare).

The manual commands are below. **Use a bash shell** for them, not Windows PowerShell.

### 1. Create the key and certificate

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -days 365 \
  -subj "/CN=engine.example.com" -addext "subjectAltName=DNS:engine.example.com" \
  -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE" \
  -keyout engine-server-a.key -out engine-server-a.crt
```

Repeat with `-b` file names for the spare. `-nodes` leaves the private key file unencrypted, so restrict it straight away
(`chmod 600 engine-server-a.key`).

### 2. Calculate the pin

```bash
openssl x509 -in engine-server-a.crt -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl base64 > engine-server-a.spki.sha256
```

### 3. Check the pin before using it

A broken pipeline can still print a believable pin, so check each one against a second method:

```bash
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(new c.X509Certificate(f.readFileSync(process.argv[1])).publicKey.export({type:'spki',format:'der'})).digest('base64'))" engine-server-a.crt
```

- The output must equal the contents of the `.spki.sha256` file.
- The pin must decode to exactly 32 bytes.
- **It must not be `47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`.** That's the SHA-256 of empty input, which is what you get when an
  earlier step in the pipeline failed.
- Pins A and B must differ.

### 4. Store the spare

Move B's private key into encrypted offline custody, then delete the unencrypted file from the admin machine. Keep only B's certificate
and pin on release systems.

### Windows

| Problem | What happens | Fix |
| --- | --- | --- |
| **Windows PowerShell pipes** | They corrupt binary data, so step 2 prints a **wrong pin with no error** | Use Git Bash or WSL |
| **Git Bash rewrites `/CN=...`** | It treats the value as a file path, and step 1 fails | Run `export MSYS_NO_PATHCONV=1` first |
| **`OPENSSL_CONF` points to a missing file** | `openssl req` fails with `Can't open ... openssl.cnf`. A PostgreSQL ODBC install can cause this | Run `unset OPENSSL_CONF` in that shell |

## Delivering pins to the engine team

Give them the pin set through their reviewed build process, for each environment:

```json
{
  "environment": "production",
  "gateway": "https://engine.example.com:3443",
  "active": "A",
  "pins": [
    { "label": "A", "spkiSha256": "<base64, 32 bytes, no sha256/ prefix>" },
    { "label": "B", "spkiSha256": "<base64, 32 bytes, no sha256/ prefix>" }
  ]
}
```

## Installing on the gateway

All files are read at start-up, so changing one needs a restart.

| Setting | Example | Meaning |
| --- | --- | --- |
| `DEVICE_ENGINE_ENABLED` | `true` | Starts the 3443 listener |
| `DEVICE_ENGINE_HOST` | `0.0.0.0` | Listener address (`127.0.0.1` locally) |
| `DEVICE_ENGINE_PORT` | `3443` | Must differ from `PORT` |
| `DEVICE_TLS_KEY` | `/certs/engine-server.key` | **Secret.** Private key of the active server key |
| `DEVICE_TLS_CERT` | `/certs/engine-server.crt` | Its certificate |
| `DEVICE_TLS_PIN_FILE` | `/certs/engine-server.spki.sha256` | The active pin |
| `DEVICE_CA_BUNDLE` | `/certs/device-ca-trust.pem` | The device CAs, which check device certificates. It has nothing to do with the pin, but the listener needs it |

The gateway refuses to start if:

- the key and certificate don't match;
- the certificate's key doesn't hash to the value in `DEVICE_TLS_PIN_FILE`, which stops a key being changed by accident before its pin
  has shipped;
- this OpenSSL build doesn't support the `SecP256r1MLKEM768` key exchange the listener requires.

Never put a spare server key on the gateway.

## Check the live server

Run this from **outside** the server. It needs OpenSSL 3.5 or later.

```bash
openssl s_client -connect engine.example.com:3443 -tls1_3 -groups SecP256r1MLKEM768 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64
```

The output must equal the active pin. If you see `47DEQpj8...`, the connection failed. If the connection shows a Let's Encrypt
certificate, traffic is going through Traefik, so stop and fix that.

The listener only accepts TLS 1.3 with `SecP256r1MLKEM768`. Ordinary `curl` and most monitoring probes will fail the handshake, which
doesn't mean the listener is down.

## Rotation

### Renewing the certificate, same key (yearly)

The pin doesn't change, and no engine release is needed. Use the KMS repository, which keeps the key and refuses a mismatched pin:

```bash
cd D:\OneBoatSolutions\servers\Cipherion-KMS
make pin-renew
make server-push SERVER=user@YOUR_SERVER_IP     # then restart the gateway in Coolify
```

Or by hand:

```bash
openssl req -x509 -new -key engine-server-a.key -sha256 -days 365 \
  -subj "/CN=engine.example.com" -addext "subjectAltName=DNS:engine.example.com" \
  -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE" \
  -out engine-server-a.crt
```

Calculate the pin again to confirm it's unchanged, replace the certificate file, restart the gateway, and run the live check.

`make expiry` doesn't watch this certificate. The gateway logs a warning daily from 30 days before it expires, but alerts need to be set up on that log, so also
put its expiry in a calendar. **Open question:** whether the engine also enforces
certificate dates. If it does, an expired certificate breaks connections even though the pin matches.

### Changing the key (planned, or after a compromise)

This takes an engine release, but the release comes **after** the server has moved to the spare.

| Stage | Server uses | Engines compiled with | Action |
| --- | --- | --- | --- |
| Start | A | R1: A+B | B's private key stays offline |
| Cutover | **B** | R1: A+B | Bring in B's key, set the three `DEVICE_TLS_*` files, restart, run the live check. R1 keeps working |
| Update window | B | R1 and R2: B+C | Generate spare C offline. Ship R2 **while serving B**, and set a deadline |
| Next cutover | **C** | R2: B+C | Only after the deadline. R1 now fails, as designed |

Two orderings lock engines out:

- **Never ship B+C while the server still uses A.** Updated engines would reject the server.
- **Never roll back to A once B+C has shipped.** Those engines no longer have A's pin.

### If a key is compromised

Changing the server doesn't remove a pin from installed engines, and there's no remote pin revocation, because adding one would defeat
pinning. Whoever holds a compromised key can impersonate the gateway to any engine that still has its pin, as long as they can also
intercept that engine's traffic.

- **Active key compromised:** cut over to the spare at once, then ship an emergency engine release without the compromised pin.
- **Spare key compromised:** keep serving the active key, generate a new spare, and ship an emergency release with the active pin and
  the new one.

### Rotations that don't affect pins

Device CA promotion and `gateway.crt` or transport CA renewal never change a pin and need no engine release. They only need the new files
and a gateway restart.

## Before production

- **Custody:** spare keys offline, secret file permissions on the active key, a backup of the active key, and named custodians.
- **Engine update path:** an engine holding only retired pins can't reach the gateway at all, so its update must not depend on this
  connection. This is the engine and agent teams' work, and it blocks going live.
- **Engine behaviour:** the engine team reports enforcing two pins, but their source hasn't been reviewed. Confirm it with a live test on
  staging.
- **Expiry alert:** alert on the gateway's daily certificate log, because `make expiry` doesn't cover this certificate.

## What was tested

Run on 2026-11-06 in Git Bash, with OpenSSL 3.5.7 and Node 22.23.2, using throwaway keys.

| Test | Result |
| --- | --- |
| Generate two keys and certificates | Correct name, `serverAuth` and `CA:FALSE`, valid for 1 year, and the two pins differ |
| Pin from OpenSSL, Node and the private key | All three match, and the pin is 32 bytes |
| Renew the certificate with the same key | New serial number, same pin |
| Live check against a local TLS server using the planned settings | Matches the pin |
| Classical-only key exchange, and TLS 1.2 | Both refused |
| Same pin pipeline in Windows PowerShell 5.1 | **Wrong value, with no error** |
| The KMS repository's pin tooling (`make pin-setup`, `make pin-renew`) | Creates a working key, keeps it on a second run, keeps the pin on renewal, and refuses a wrong pin file |
| The built gateway with the listener on | Live check from OpenSSL matches the pin file |
| Start-up with a mismatched key, a wrong pin file or a bad CA bundle | Refused |

Not tested: a real Coolify or Traefik deployment, and a real engine.
