# Cash on Delivery collection

## Policy

Fulfillment and payment are independent. Checkout creates pending/unpaid COD
orders as before. Delivery does not imply collection. Only a currently authorized
administrator may explicitly confirm collection of the full stored order total
for a delivered, unpaid COD order. Zero-total orders follow the same policy.
Pending, confirmed, shipped, cancelled, already-paid, and conflicting audit
states cannot be collected. Missing legacy payment status requires data review;
it is not silently interpreted as unpaid. Existing unpaid delivered orders are
eligible without migration. Refunds, partial collections, payment reversal,
online gateways, and customer self-confirmation are not implemented.

Paid orders cannot be cancelled, including legacy paid pending/confirmed orders.
Unpaid pending/confirmed cancellation retains its transactional stock restoration.
No payment request changes fulfillment, stock, cart contents, prices, or totals.

## API and audit

`POST /api/admin/orders/:id/collect-cod`

```json
{ "confirmed": true }
```

Requires Bearer authentication and current database admin authorization. IDs must
be 24 hex characters; confirmation must be boolean true, with no extra fields.
Client amounts, timestamps, actors, and arbitrary payment-status edits are
rejected. Generic order status updates still accept only fulfillment status.

Success: 200 `{ message, order }`, using the existing admin order shape plus
optional `paidAt` (ISO timestamp) and `paymentCollectedBy` (administrator ID).
Amounts come from the stored order. Audit fields are assigned together with
`paymentStatus: paid` in a single conditional MongoDB update. The time comes
from MongoDB `$currentDate`, and the actor comes from authenticated middleware.
There is exactly one audit tuple on the order; duplicate requests cannot append
events, replace its actor/time, or count another payment. Actor IDs survive an
administrator's later deletion; no unnecessary actor profile details are exposed.

Errors: 400 invalid ID/body, 401 missing/invalid/deleted account, 403 current
non-admin, 404 missing order, 409 duplicate/ineligible/stale collection, and safe
500 on unexpected failure. Malformed JSON is sanitized to 400 JSON; bodies over
the existing 100 KiB parser limit receive safe 413 JSON on this endpoint.
No automatic retries are performed. After a network
failure, refresh/review the order before trying again: the first request may
already have committed. The endpoint returns `Cache-Control: no-store` on success.

Audit fields have no defaults and are excluded from ordinary Mongoose selection.
Admin order list/details and update responses explicitly select them; customer
history/details retain their existing payloads and payment-status display.
Existing paid rows lacking audit metadata remain paid, cannot be reconfirmed,
and display a legacy-audit notice. No audit information is backfilled or invented.

## Reporting and UI

The order detail page uses a shared Button and a native confirmation dialog
showing the full stored amount. It displays pending/success/error feedback and
collection timestamp/administrator ID. Eligibility is reflected in the UI and
enforced again on the server. Success and stale/error outcomes refresh order,
customer, and analytics caches; no payment mutation automatically replays.

Original analytics fields keep their definitions: paid/non-cancelled order value
in the selected **order creation** period. The new additive `collections` summary
and trend use **paidAt**, so collecting an older order appears in today's
collection period without rewriting the old report's meaning. Both include
shipping and exclude unpaid/cancelled orders. Only collection-date metrics omit
legacy paid rows without a collection timestamp. Customer spending remains
non-cancelled order value, including unpaid orders. Currency remains PHP.

## Validation and manual checks

```powershell
# From server/, with local mongod installed (or MONGOD_BINARY configured):
node --import tsx --test tests/codCollection.integration.test.ts tests/adminAuthorization.test.ts tests/adminAnalytics.integration.test.ts tests/cartCheckout.integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
# From admin/:
npm.cmd test
npm.cmd run build
npm.cmd run lint
```

Integration tests start a fresh disposable loopback replica set. They never load
`.env`, connect to application data, or mutate production records. A barrier
holds concurrent collection queries before database execution to verify one
winner, one conflict, one audit tuple, one counted collection, and unchanged
stock. Other coverage checks eligibility, safe errors, auth revocation, customer
privacy, cancellation, original checkout, and collection/date boundaries.

Using disposable local fixtures only:

1. Deliver an unpaid COD order through existing fulfillment actions. Confirm it
   still displays unpaid. Click Confirm COD Collection; cancel the dialog and
   verify no request occurs. Confirm again and accept; check paid status, timestamp,
   administrator ID, success message, and unchanged stock.
2. In two admin tabs, confirm the same order: one succeeds, the stale tab gets a
   recoverable conflict and refreshes to paid. Retrying directly in Postman returns
   409 and does not change the original actor/time.
3. Check missing/expired token (401), normal customer and demoted admin (403),
   deleted admin (401), bad ID/body (400), missing order (404), and cancelled or
   not-yet-delivered order (409). Extra amount/audit fields must return 400.
4. Verify an old order collected today affects today's collections but retains
   its creation-date cohort revenue. Change day/week/month grouping and empty
   ranges. Legacy paid orders with no timestamp should not create collection rows.
5. Open customer history/details: paid status updates on refresh, without the
   collector ID or payment audit timestamp. Check desktop/mobile layout, keyboard
   focus, confirmation cancellation, pending states, and network-failure recovery.

## Deployment and limits

Backend changes are additive; old admin/frontend consumers may ignore new fields.
Deploy the backend before or with the new admin UI. Build/restart the backend and
use the normal deployment index process for the partial `paidAt` reporting index.
No destructive migration is needed. Existing transaction-capable MongoDB remains
required for fulfillment cancellation/checkout; collection itself is single-
document atomic and needs no multi-document transaction.

This is an administrator attestation of cash collection, not independent proof
that cash was received. Audit data is application-protected, not tamper-proof
against direct database access. Existing Number-based money storage and JWT
revocation limits remain unchanged. No accounting reconciliation/export, refund
ledger, override/backdating endpoint, or immutable external audit store is added.
