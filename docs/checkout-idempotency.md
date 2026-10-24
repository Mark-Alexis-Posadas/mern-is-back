# COD checkout idempotency

## Existing guarantee and retry gap

Cart identity/version compare-and-swap already prevents two orders consuming the
same reviewed revision, even across tabs. Stock, order, audit and cart completion
roll back together. A lost response after commit previously left a retry with a
stale-cart 409 and no way to identify the successful order.

## API and durable identity

POST /api/orders accepts the existing cartId, version, shippingAddress and COD
paymentMethod, plus optional idempotencyKey (16-128 ASCII letters, digits, hyphen
or underscore; the storefront generates crypto.randomUUID()). Existing unkeyed
clients remain compatible with revision protection but cannot recover a lost
response by key. Deploy server/index first, then the new client.

New and replayed successful requests both return HTTP 201 and the existing safe
customer Order shape. A replay returns the same order identity and stored prices,
with its current fulfillment/payment state. No key/fingerprint audit is exposed.
GET /api/orders/checkout-attempts/:key returns that customer's committed order
(200), or CHECKOUT_NOT_FOUND (404). A 404 is NOT proof that an in-flight original
request will fail. Both endpoints require existing current-account authentication,
return no-store responses, and never select another customer's order.

CheckoutAttempt has a unique compound index on user/key, SHA-256 fingerprint and
order reference. The fingerprint uses cart ID/version, COD and an explicit fixed
sequence of trimmed shipping fields (missing/empty addressLine2 are equivalent).
It never uses client prices. The unique reservation is inserted before stock
writes in the SAME transaction as order, sale movements and cart completion.
Only committed attempts are visible. Failures roll back the reservation too.

Matching committed results are checked BEFORE the consumed cart revision. A
transaction retry also checks its snapshot's reservation. Duplicate-key races and
unknown commit outcomes are resolved through a majority read of the durable
attempt outside the transaction; a recovered result never changes stock/cart.
Transactions use snapshot reads, majority writes, 15-second operation timeout and
5-second maximum commit time. The driver retries eligible conflicts/commit
acknowledgements; exhausted/ambiguous attempts can be checked or retried explicitly.
Recovery reads use a three-second server execution bound (connection timeouts are
separate). No in-memory backend map is used.

Errors:

- 400: existing input/stock/availability validation, or invalid key. No successful
  attempt is recorded. Fixing a failed attempt does not create a cached success.
- 409 CART_CONFLICT: existing stale revision, with no matching committed attempt.
- 409 CHECKOUT_KEY_CONFLICT: key committed with different canonical inputs. Never
  silently change the payload or generate a replacement key to bypass this.
- 503 CHECKOUT_RETRYABLE, Retry-After: 1: a unique/transaction/commit outcome cannot
  yet be resolved. Retry/check the SAME attempt. Other safe 5xx are also uncertain.
- 401 retains existing session recovery; regular network/403 behavior is unchanged.

## Frontend recovery

The first explicit Place Order action generates one key and binds canonical
inputs. Retries send the same in-memory payload and key. Pending guards reject
rapid duplicate submissions; TanStack mutation auto-retry remains disabled.
No network/timeout/5xx response automatically creates or submits another attempt.

Session storage retains only account-scoped key, cart identity/version, salted
local payload hash and outcome, not shipping address or token. In-memory shipping
payloads are forgotten on logout/account changes, while non-sensitive recovery
metadata remains available when that same customer returns. Another customer never
loads it. A current-session predicate guards asynchronous preparation before send,
and existing mutation/navigation guards ignore responses after account changes.

After refresh, Check order can recover a commit even if the cart is empty or its
GET fails. To retry a noncommitted attempt, re-enter the original shipping inputs;
the local hash must match and the original cart revision is used. A confirmed
400/CART_CONFLICT failure offers an explicit Start a new checkout attempt action.
Unknown results cannot be silently discarded. Navigating away during a request
retains metadata; returning to checkout can recover it. Completion removes only
that matching attempt after the current customer can navigate to the order.

## Deployment and limitations

Create the unique checkoutattempts user/key index BEFORE accepting keyed traffic:
use normal reviewed deployment tooling to create { user: 1, key: 1 } with unique:
true. Do not rely on a production autoIndex default, run destructive syncIndexes,
or deploy the keyed frontend before this index exists. This task only builds
indexes inside isolated test fixtures; no production data/index is touched.
No historical backfill is needed. Keep attempt records with their orders; no TTL
is used because expiry could allow accidental key reuse. Account/order deletion
and archival must preserve this relationship or provide a deliberate retention
policy. Old orders/unkeyed checkouts have no recoverable attempt record.

Offset history, pricing, cancellation, fulfillment, inventory audit and COD
collection rules are unchanged. Different keys cannot consume one cart revision
_twice_, but a genuinely new cart revision is a new purchase and requires review.
There is no cross-device key synchronization. Clearing/denying session storage or
closing the tab can lose recovery metadata; server guarantees still hold and My
Orders remains available. No address is persisted: if the original details cannot
be re-entered (or the cart has since been emptied), use Check order/My Orders and
resolve uncertainty before starting a new purchase. No automatic retry/backfill,
payment gateway, online payment or refund system is introduced.

## Manual checks

1. Place an ordinary COD order; verify unpaid status, stock deduction, one sale
   movement per product and a single cart revision increment.
2. Disable the response after POST commits; use Retry same checkout or Check order
   and verify navigation to the same order with no new movement/stock change.
3. Refresh while uncertain, including after the cart becomes empty; Check order
   still works. Confirm sessionStorage contains no shipping address.
4. Send simultaneous keyed requests and changed-address replays: one order only,
   and changed input returns CHECKOUT_KEY_CONFLICT.
5. Simulate offline/503 before completion, then explicitly retry. Verify no automatic
   second request or replacement key. Exercise validation and stale-cart failures.
6. Switch accounts while preparing/submitting and confirm no old-account recovery
   data is rendered or used by the new account. Return as the original customer
   to check the retained key. Verify cancellation and COD collection still work.

Tests use replica-set fixtures, promise barriers, injected persistence/commit
failures and a deliberately destroyed HTTP response, plus SSR/memory frontend
harnesses. Browser interaction still needs the manual checks above.
