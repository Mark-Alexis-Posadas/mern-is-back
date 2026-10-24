# Customer COD cancellation

POST /api/orders/:id/cancel requires the existing bearer authentication and exactly
`{ "confirmed": true }`. Success returns the existing customer Order shape.
Missing or foreign orders (including malformed IDs) return 404; missing credentials
return 401; invalid confirmation returns 400; ineligible/duplicate requests return 409. Unexpected persistence failures return a safe 500; clients should refresh
before retrying because a network failure can conceal a successful commit.

Only the owner may cancel pending or confirmed unpaid COD orders. No refund,
payment mutation, cart recreation, or arbitrary customer status update is provided.
Ownership and eligibility are read inside the transaction. Fulfillment writes to
the same order cause write conflicts and transaction retries recheck eligibility.
The shared stock restoration helper serves admin and customer flows, sums legacy
duplicate product lines, and logs one customer-attributed cancellation movement
per product using the same session. A failure aborts stock, movements, and status.
Existing unique order/product/type movement indexes remain unchanged.

The details page provides browser-native explicit irreversible confirmation,
pending/success/error feedback and order/product cache invalidation. History links
continue to lead to details. No automatic mutation retry is enabled.

Manual verification: create a two-product COD order, cancel from its detail page,
then check restored stock and customer-attributed inventory history in admin.
Repeat cancellation (409), try another account (404), ship an order in admin before
cancelling (409), and verify delivered/paid orders have no cancellation action.
A MongoDB replica set is required, as for existing checkout. No historical data
migration or production data access is required. Browser interaction still needs
manual verification.
