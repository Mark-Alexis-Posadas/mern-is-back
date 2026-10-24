# Customer order history

GET /api/orders/my uses existing bearer authentication and scopes both rows and
counts to req.user.id. No user selector is accepted. The only repository consumer,
MyOrdersPage, was migrated with this endpoint; external array consumers must migrate.

Parameters:

- page: positive integer, default 1, maximum 10,000; offset cannot exceed 10,000.
- limit: positive integer, default 10, maximum 50.
- orderStatus: pending, confirmed, shipped, delivered, or cancelled; omit for all.
- paymentStatus: unpaid or paid; omit for all.
- sort: newest (default) or oldest.

Unknown, duplicate, structured and invalid query parameters return safe 400 JSON
errors. Unauthenticated/deleted accounts retain existing 401 behavior.

Response:

```json
{ "items": [], "total": 0, "page": 1, "limit": 10, "totalPages": 0 }
```

Items use an explicit customer-field projection: identifiers, item snapshots,
shipping address, COD method, payment/fulfillment status, totals and timestamps.
No paidAt, paymentCollectedBy or inventory audit data is selected. Responses are
no-store. Out-of-range pages return empty items with the true filtered total.
Count and item queries are independent and can briefly differ during order updates.

The existing user/createdAt index is extended with _id to support stable ordering
and reverse scans for oldest-first. No speculative status-index combinations are
added: both status filters remain scoped to one user's indexed order range. Both
queries have maxTimeMS(3000), and offset/limit work is bounded. Measure production
query plans before adding further indexes. Roll out the replacement index through
normal deployment tooling; this task performs no production index/data operations.
The older index may remain until deliberately reviewed; do not run syncIndexes.

Filters, sorting, page and page size are URL driven. Filter/sort changes reset
page 1. Detail links retain a restricted local return URL, including error-page
back links. Query keys include every effective filter and requests receive abort
signals. Existing cancellation invalidation refreshes every filtered history key.
Matching Orders is the filtered total; pending counts and order value are explicitly
labeled as page values, not lifetime totals. COD remains the only payment method.

Manual browser checklist: exercise each status, combine payment/status filters,
change newest/oldest, paginate, reset, share URLs, and use back/forward. Open details
and return using the breadcrumb. Cancel an eligible unpaid order and verify it
leaves a pending/confirmed filter and appears under cancelled. Check empty and
out-of-range pages, retry failures, keyboard controls and mobile layout. UI tests
use SSR and memory-router history; they do not replace real browser verification.
