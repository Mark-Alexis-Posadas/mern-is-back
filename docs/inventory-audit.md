# Transactional inventory history

All application stock-changing paths now write movements in the **same MongoDB
session/transaction** as their stock and business updates. Audit persistence is
mandatory: a movement failure aborts stock, order/status, cart, and other movement
writes in that transaction. The audit helper never changes stock itself.

## Model and compatibility

Existing `product`, `admin`, signed `adjustment`, `previousStock`, `newStock`,
`reason`, and timestamps remain. New fields are additive:

| Field       | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `type`      | `manual`, `sale`, or `cancellation`                                   |
| `actorType` | `admin`, `customer`, or `system`                                      |
| `actor`     | User ID when applicable; populated with name/email on admin history   |
| `order`     | Order ID for sale/cancellation; never a customer-supplied audit value |
| `note`      | Optional human-readable context, at most 500 characters               |

`admin` is optional so checkout does not impersonate an administrator. New admin
movements retain both `admin` and `actor` for existing consumers. Legacy manual
rows without type/actor fields remain readable: the API normalizes them to
`manual` / `admin` and falls back to the populated legacy `admin` field. Missing
users/products remain nullable; history is not deleted with the referenced data.

Every new movement validates safe-integer, non-negative before/after stock,
nonzero signed delta, and `before + delta = after`. Sales are negative;
restorations positive. Audit rows are append-only through application APIs;
there are no movement edit/delete/customer-write endpoints. This is not a
tamper-proof log against direct database administrators.

Indexes retain product/date history and add global date, type/date, and a unique
partial `(order, product, type)` index for order-linked rows. This allows one sale
and one cancellation per order/product while excluding existing manual records.
Use the normal deployment index process; no production index/data operations or
automatic historical backfill are performed by this task.

## Business operations

- **Checkout:** each conditional atomic deduction returns its authoritative
  pre-update product. A sale row records that stock, the deducted quantity,
  customer actor, and the order ID allocated inside that transaction attempt.
  Order persistence/cart revision clearing remain unchanged. Driver retries roll
  back attempted rows; repeated reviewed-cart checkout cannot duplicate them.
- **Cancellation:** eligible unpaid pending/confirmed orders restore each item
  using atomic pre-update values, then record admin-triggered restoration rows
  before status commit. API calls supply the authenticated admin. Existing
  internal service callers without an admin are explicitly `system` actors.
  Repeated/concurrent cancellation follows existing terminal-status checks.
  Duplicate legacy product lines are summed and restored once per product.
  Missing products, invalid quantities, unsafe stock, or audit failure abort
  restoration. Paid cancellation remains forbidden.
- **Manual adjustments:** existing validation, reason, endpoint, and response
  remain. The conditional stock write and new typed row share the same session.
- **Product creation:** positive initial stock is a manual movement from zero.
  Zero-stock creation writes no movement. Product creation and its initial row
  commit together, so product creation now also needs transaction-capable MongoDB.
- **Legacy product edits:** the existing `/api/products/:id` admin PATCH can
  replace absolute stock. Its stock-changing branch now computes a manual delta
  transactionally and records the authenticated admin without changing its
  request/success shape. Replacing stock with the same value writes no movement.
  The newer `/api/admin/products/:id` edit continues to reject stock changes and
  uses the dedicated adjustment endpoint instead.
- **COD collection, fulfillment without stock changes, product metadata edits,
  soft deletion and cart edits:** no movements. Pricing/payment rules are unchanged.

The history is not a stock reservation or an opening-balance ledger. Current
product stock remains authoritative. All future stock writers must follow these
transaction/audit rules rather than modifying Product directly.

## History API and UI

Existing GET paths and response envelope remain:

- `/api/admin/inventory/movements`
- `/api/admin/products/inventory/movements` (legacy alias)

Both require authentication and current admin privileges. Existing pagination,
literal product-name/SKU search, `productId`, and `type=all|added|removed` remain.
Added/removed are signed-direction filters across **all** sources. New source
filters are `type=manual|sale|cancellation`; optional `orderId` filters related
order movements. Search still uses current Product name/SKU; deleted products
are visible in unfiltered/product-ID history but cannot match a missing current
product name. Response records add type/actor/order/note fields; old fields stay.

The admin table shows source, signed delta, before/after, actor role/profile,
reason, timestamp, and a safe link to existing admin order details. Product links
initialize `productId` from the inventory URL. Existing search, direction filters,
pagination, page statistics, and responsive table scrolling remain. Manual stock,
product creation, and order-status actions invalidate relevant inventory caches.
Customer checkout occurs in another app; an already-open admin page must refresh
to see new activity (no realtime subscription was added).

## Historical limitations

Older sales/restorations were not logged. Do **not** infer that historical totals
reconcile with today's stock, invent before/after values, or relabel old rows as
newly observed facts. A cancellation of a pre-deployment order can legitimately
have a restoration row without an earlier sale row. If reconciliation is later
needed, plan an independently reviewed, idempotent migration with backups and an
explicit provenance marker. Historical before/after values cannot generally be
reconstructed from orders alone because manual changes interleave. No migration
or backfill runs automatically.

## Validation and manual verification

```powershell
# server/; requires local mongod or MONGOD_BINARY
node --import tsx --test tests/inventoryMovements.integration.test.ts tests/cartCheckout.integration.test.ts tests/codCollection.integration.test.ts tests/adminAuthorization.test.ts tests/auth.test.ts tests/adminCustomer.test.ts tests/adminAnalytics.test.ts tests/adminAnalytics.integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
# admin/
npm.cmd run build
npm.cmd run lint
npm.cmd test
```

Tests use only disposable loopback replica sets and synthetic fixtures, never
`.env`, MONGO_URI, or production data. Barriers overlap real database reads before
last-stock purchases, cancellations, and manual-versus-checkout writes. Failure
injection verifies sale/restoration/manual/product rollback. Startup polling is
only MongoDB readiness handling, not concurrency synchronization.

Using disposable local fixtures:

1. Adjust stock up/down and create a stocked product. Check manual rows, actors,
   reasons and arithmetic; zero-stock creation should add no row.
2. Checkout multiple products. Verify one sale per product/order, customer actor,
   and exact stock decrease once. The cart should clear only after success.
3. Cancel an eligible order. Check restoration rows link to the same order and
   restore stock once. Retry cancellation: no extra movement or stock increase.
4. Deliver/collect COD for another order: collection creates no inventory row.
5. Filter by sales/cancellations/manual and added/removed; search SKU, paginate,
   follow order links and Products' history links. Confirm old manual rows and
   deleted-reference fallbacks remain readable.
6. Check anonymous/customer history denial, desktop/mobile table scrolling,
   keyboard filters/links, loading/error/retry, and empty results. Browser visual
   and keyboard verification remains a manual step; rendering tests cover content.
