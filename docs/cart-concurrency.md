# Cart concurrency and checkout

Cart PUT and order POST paths are unchanged. The customer frontend and backend
must be deployed together: writes now require the reviewed `cartId` and `version`.
Old clients get a controlled 400 asking them to reload rather than an unguarded
write. No cart/order/customer records are migrated.

## Contract

GET `/api/cart` returns:

```json
{
  "_id": "abcdef012345abcdef012345",
  "user": "012345abcdef012345abcdef",
  "version": 1,
  "items": [
    { "productId": "fedcba012345fedcba012345", "product": null, "quantity": 1 }
  ]
}
```

An account without a cart gets `_id: null`, `version: 0`, `items: []`. Products
remain populated objects when available. Deleted references return `product:
null` while `productId` survives for removal. Inactive products remain visible.

PUT `/api/cart` accepts:

```json
{
  "cartId": "abcdef012345abcdef012345",
  "version": 1,
  "items": [{ "product": "fedcba012345fedcba012345", "quantity": 2 }]
}
```

The first PUT uses `cartId: null, version: 0`; the unique cart/user index allows
one competing creation. Successful writes return the new snapshot. Existing
carts atomically compare user, ID, and version and increment `__v` (exposed as
`version`). The first persisted version is 1. Legacy version-zero documents,
including documents missing `__v`, can advance without migration.

Order POST `/api/orders` requires the same `cartId` and `version`, alongside the
existing shipping address and COD payment method. Successful order responses
are unchanged. Checkout reads exactly that revision; every transaction retry
uses the original reviewed revision. Stock deductions, order creation, and cart
clearing are one transaction. Clearing retains cart identity and increments the
revision, preventing old tabs from restoring checked-out contents.

Stale writes/checkouts return 409 `{ "message": "Your cart changed. Reload it,
review your items, and try again." }`. Validation remains 400, unauthenticated
requests 401, and another user's order 404. Supplying another user's cart ID
never selects their cart; a mismatched snapshot produces the same 409.

The client refetches authoritative cart state on mutation errors, displays the
server's recovery message, and does not automatically replay an edit. Checkout
also refreshes cart/products after stock validation or revision conflicts.
Queries support cancellation; late mutation responses cannot overwrite a newer
revision in the cache. Busy indicators coordinate this page's QueryClient only;
MongoDB revision checks protect simultaneous requests and other browser tabs.

Unavailable rows can be retained unchanged or decreased while another bad row
is removed, but cannot be added/increased. This permits recovery from multiple
unavailable items. Checkout rejects every deleted/inactive/insufficient-stock
item both in the UI and server. Carts do not reserve stock.

## Verification

From `server/`, with local `mongod` installed (or `MONGOD_BINARY` set):

```powershell
node --import tsx --test tests/cartCheckout.integration.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Tests start an isolated loopback replica set and fresh temporary database. They
never load `.env` or connect to the application database. Barrier-controlled real
database reads/writes exercise overlapping edits, first writes, checkouts, final
stock purchases, and both checkout-versus-edit orderings. Startup polling only
waits for MongoDB readiness; concurrency tests use no timing sleeps. Other tests
inject failures after stock deduction/order creation to verify rollback, and
exercise unavailable items, validation, and customer ownership via real routes.

From `client/`:

```powershell
node --test tests/cart.test.cjs
npm.cmd run build
npm.cmd run lint
```

Client tests render cart/checkout states and exercise the real cart hook with
mocked HTTP boundaries. They verify orphan removal, revision payloads, 409
refetch without automatic replay, and stale mutation-response protection.

## Manual checks and limits

1. In two signed-in tabs, load the same cart. Edit one, then edit the stale tab:
   expect 409, a recovery message, and the authoritative contents. Retry after
   review; the new revision should succeed.
2. Load checkout in one tab, change the cart in another, then submit the old
   checkout: expect 409 and no order/stock changes for that failed checkout.
3. Complete checkout, then try an old cart write: it cannot resurrect old items.
   Only the reviewed cart clears, its ID remains, and its version increases.
4. Using disposable local fixtures, deactivate/delete a referenced product:
   the row remains visible/removable, and checkout is disabled. Remove multiple
   unavailable rows one at a time, then continue shopping.
5. Check another customer's cart ID/order ID cannot grant access. Use the
   isolated integration suite for simultaneous final-stock and rollback checks.

Transactions require a replica set or sharded MongoDB in deployment. The existing
unique user/cart index must be present before serving writes. No production
index-building or data operations are performed by this task.

Stock and price can change after a cart read; checkout continues to use current
server prices and conditional stock deductions, not a price reservation. A cart
read combines its atomic snapshot with subsequently queried product metadata;
it is not a transactionally frozen catalog view. Direct database writes or other
future cart writers that bypass revision increments invalidate the guarantees.
There is no general checkout idempotency key: after an ambiguous network result,
review order history instead of blindly rebuilding and resubmitting the cart.
Visual/keyboard behavior still needs an interactive browser check.
