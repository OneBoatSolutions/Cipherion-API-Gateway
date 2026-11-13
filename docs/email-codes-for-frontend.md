# Email codes replace email links: what the frontend changes

Email verification and password reset now send the user a **6-digit code** by email, instead of a link. The user types the code into
the frontend, which sends it to the gateway. The emails contain no links at all.

All paths are under `/api/v1/auth`. Send JSON with the `Origin` header of a trusted origin, as for every other auth call.

## Endpoints that no longer work

Each one now answers **`404`**.

| Method | Path | Was used for | Use instead |
| --- | --- | --- | --- |
| `GET` | `/verify-email?token=…&callbackURL=…` | The verification link in the email | `POST /email-otp/verify-email` |
| `POST` | `/send-verification-email` | Sending a new verification link | `POST /email-otp/send-verification-otp` |
| `POST` | `/request-password-reset` | Emailing a reset link | `POST /email-otp/request-password-reset` |
| `GET` | `/reset-password/:token?callbackURL=…` | The reset link in the email | Not needed: there's no link |
| `POST` | `/reset-password` | Setting the new password with the link's token | `POST /email-otp/reset-password` |

Also never available, although Better Auth's email-code plugin would otherwise add them:

- `/sign-in/email-otp`
- `/forget-password/email-otp`
- `/email-otp/check-verification-otp`
- `/email-otp/request-email-change`
- `/email-otp/change-email`

### What to remove from the frontend

- **Sign-up:** don't send `callbackURL` to `POST /sign-up/email`. No email link lands on a page any more.
- **Landing pages:** the pages that handled `?verified=…`, `?token=…` and `?error=INVALID_TOKEN` (the email links' landing pages) are no longer needed.

## Endpoints to use

### Sign up and verify the email

1. **`POST /sign-up/email`**
   - Body: `{ "name", "email", "password" }`
   - Unchanged, except that it emails a code. It returns `token: null` and no session cookie.
2. **Show a screen that asks for the code.**
3. **`POST /email-otp/verify-email`**
   - Body: `{ "email", "otp" }`
   - Success (`200`): `{ "status": true, "token": null, "user": { …, "emailVerified": true } }`
   - **It creates no session.** Send the user to sign in with their password next.
4. **`POST /sign-in/email`**
   - Body: `{ "email", "password" }`
   - Unchanged.

### Send a new verification code

**`POST /email-otp/send-verification-otp`**
- Body: `{ "email", "type": "email-verification" }`
- `type` must be exactly `"email-verification"`; anything else answers `400`.
- It answers `{ "success": true }` whether or not the account exists.
- The new code replaces the old one, which stops working.

### Sign-in before the email is verified

`POST /sign-in/email` still answers **`403`** with `code: "EMAIL_NOT_VERIFIED"`, and it **emails a new code**. Show the code screen, the
same as after sign-up.

### Forgot password

1. **`POST /email-otp/request-password-reset`**
   - Body: `{ "email" }`
   - It answers `{ "success": true }` whether or not the account exists. Always show the same message, such as "If that email has an account, a code is on its way."
2. **Show a screen** with the code and a new password field.
3. **`POST /email-otp/reset-password`**
   - Body: `{ "email", "otp", "password" }`
   - Note that the field is `password`, not `newPassword`.
   - Success (`200`): `{ "success": true }`. The reset signs the user out **everywhere**, and marks the email verified.
   - Then send the user to sign in with the new password.

Ask for a new reset code with the same `POST /email-otp/request-password-reset`.

## Rules for codes

- 6 digits. Accept digits only, and use `inputmode="numeric"` and `autocomplete="one-time-code"` on the field.
- A code lasts **10 minutes** and works **once**. Only the latest code sent works.
- After **3 wrong tries**, the code is deleted. Then even the right code is refused, so offer "Send a new code".
- A verification code and a reset code are separate. One can't be used for the other.

## Errors

| Status | `code` | Meaning | Show |
| --- | --- | --- | --- |
| `400` | `INVALID_OTP` | Wrong code, already used, or never sent | "That code isn't right. Check the latest email." |
| `400` | `OTP_EXPIRED` | Older than 10 minutes | "That code has expired." plus "Send a new code" |
| `403` | `TOO_MANY_ATTEMPTS` | 3 wrong tries | "Too many wrong tries." plus "Send a new code" |
| `400` | – | `send-verification-otp` with a `type` other than `email-verification` | A frontend bug: fix the request |
| `429` | – | Rate limit | "Too many attempts. Wait a minute and try again." |

**Rate limits,** per IP address:
- sending a code (`send-verification-otp`, `request-password-reset`): 3 a minute
- checking a code (`verify-email`, `reset-password`): 5 a minute

## Unchanged

These routes work exactly as before:

- `POST /sign-in/email`
- `POST /change-password`
- `POST /sign-in/social`
- `GET /callback/:provider`
- `GET /get-session`
- `POST /sign-out`
