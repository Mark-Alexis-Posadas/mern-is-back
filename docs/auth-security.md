# Authentication security

Login and registration keep their existing paths and `{ user, token }` success
responses. Passwords are never returned. JWT format, seven-day lifetime, and
bcrypt hashing (cost 10 for new passwords) are unchanged.

## Input and error policies

- JSON authentication bodies are limited to 8 KiB. Throttling runs before parsing.
- Accepted fields must be primitive strings. Unknown properties are ignored;
  registration cannot set roles. Email is trimmed/lowercased and checked as a
  conventional ASCII address: at most 254 characters, local part at most 64,
  with valid DNS-style domain labels. Quoted/internationalized email syntax is
  not supported. Existing database values are not migrated.
- Registration names are trimmed, 2–100 characters, without control characters.
- New passwords follow the registration UI: at least 8 characters, an ASCII
  uppercase letter and a digit. Maximum 72 UTF-8 bytes prevents bcrypt truncation;
  NUL characters are rejected. Passwords are never trimmed or normalized.
- Login accepts existing nonempty passwords up to 1024 UTF-8 bytes, without new
  complexity rules or a 72-byte restriction. Existing bcrypt hashes and their
  historical truncation behavior remain compatible. Extremely long legacy
  passwords beyond 1024 bytes would require an account recovery process.
- Invalid input returns 400 `{ message }`; incorrect credentials return the same
  401 message for missing accounts and wrong passwords. Missing accounts perform
  a dummy bcrypt comparison. This reduces a timing difference but does not provide
  constant-time authentication, especially for historical hashes with other costs.
- Duplicate registration and duplicate-key races return a generic 400 message;
  internal errors return generic 500 responses. Because registration immediately
  creates a session (201), account existence can still be inferred from outcomes.
  Fully hiding it requires a different registration/verification flow.
- Authentication responses use `Cache-Control: no-store`. Malformed JSON returns
  safe 400 JSON; oversized bodies return safe 413 JSON. No request bodies, raw
  passwords, tokens, database diagnostics, or parser excerpts are logged.

## Throttling and deployment

- Login: 10 attempts per client IP in a fixed 15-minute window.
- Registration: 5 attempts per client IP in a fixed 60-minute window.
- All attempts count, including successful, malformed, and invalid requests.
  Limits are separate. A blocked request returns 429 `{ message }` and an integer
  `Retry-After` header in seconds. The window starts with the first attempt;
  blocked requests do not extend it. Retry is allowed at expiry.
- Each limiter stores at most 10,000 active IP buckets, cleans expired entries
  periodically, and fails closed for new keys at capacity. No background timers.
- Express `trust proxy` remains disabled. `req.ip` uses the socket peer; untrusted
  `X-Forwarded-For` is ignored. Behind a reverse proxy all users may share a bucket
  until deployment explicitly configures the actual trusted proxy topology.
  Never blindly enable `trust proxy: true`.
- Limits are per process, reset on restart, and do not coordinate across instances.
  Use a shared atomic store or trusted gateway for horizontal scaling. Shared NATs
  may experience contention; IPv6 address rotation/distributed clients can evade
  per-address limits. Add gateway/network controls as appropriate.
- The storefront renders server messages; the admin currently renders a generic
  login failure, so admin users do not see retry details without frontend work.

## Current accounts and revocation

Every `protect` request verifies the JWT and checks that its user still exists.
Only the current `isAdmin` role is loaded. `requireAdmin` shares this lookup through
a server-owned WeakMap keyed by the request object; no role cache survives a
request. Deleted accounts return 401, current non-admins return 403 on admin APIs,
and database failures fail closed with safe 500 responses. `/auth/me` separately
loads its safe profile payload. The User schema has no disabled/suspended flag;
no such status was invented.

Deletion/demotion takes effect on the next request, not midway through an already
authorized operation. Existing tokens for active users still work until expiry;
logout/password changes cannot revoke individual tokens. No refresh tokens,
denylist, session version, password reset, or session architecture redesign is
included here.

## Validation

From `server/`:

```powershell
node --import tsx --test tests/auth.test.ts tests/adminAuthorization.test.ts tests/adminCustomer.test.ts tests/adminAnalytics.test.ts tests/adminAnalytics.integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Auth tests use mocked database boundaries and in-memory Mongoose documents with
real bcrypt/JWT/HTTP middleware. Analytics integration starts its own disposable
local MongoDB; it never connects to the application database or loads `.env`.
