# Customer password reset

The customer API provides `POST /api/auth/forgot-password` and
`POST /api/auth/reset-password`. Admin accounts are excluded from both flows.
Forgot-password validates the email and always returns the same generic success
response for existing and missing customer accounts. A reset request replaces
that customer's previous link.

Tokens contain 256 bits of randomness. Only their SHA-256 hashes and a 20-minute
expiry are stored on the customer document. The reset endpoint hashes the
submitted password with the existing bcrypt cost, then uses one conditional
`findOneAndUpdate` to set the new password and remove the matching unexpired
token. MongoDB's atomic single-document update allows only one concurrent
submission to consume a link. The atomic update also increments the customer's
`authVersion`; protected requests compare that value with the JWT claim, so all
previously issued sessions are rejected and the customer can sign in again.

Email delivery uses Resend's HTTPS API when `RESEND_API_KEY`,
`PASSWORD_RESET_FROM`, and `CLIENT_URL` are configured. `CLIENT_URL` must be a
trusted HTTPS origin in production (HTTP is accepted only for localhost). The
reset URL is built from that configured origin, never the request Host header.
No secrets are included in source control. Without those settings, or if delivery
fails, the public response remains generic and the reset token is never returned
by the API; configure and verify a real sender before enabling the flow in
production.

Reset request throttling allows 3 attempts per IP per hour; reset submissions
allow 10 per IP per 15 minutes. These use the existing process-local fixed-window
limiter, so limits reset on restart and do not coordinate between server
instances. Configure a shared gateway/store for horizontal deployments. The
existing proxy trust setting remains unchanged.

Request bodies are bounded by the existing 8 KiB authentication parser. Invalid
and expired reset links share a safe error. Reset tokens and passwords are not
logged or placed in API errors. Reset records are fields on the existing User
document, so no extra collection or transaction is needed.
