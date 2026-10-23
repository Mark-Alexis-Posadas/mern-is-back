# Sales Analytics

Admin UI: `/admin/analytics`. Existing dashboard and customer spending are unchanged.

## Definitions

- **Revenue:** sum of historical `Order.total` for orders with `paymentStatus === "paid"` and `orderStatus !== "cancelled"`. Includes shipping. Missing payment status, unpaid COD, and cancelled paid orders contribute no revenue.
- **Sales count:** number of those qualifying paid, non-cancelled orders. Free paid orders count as sales.
- **Total orders / status distribution:** all orders created in the range, including unpaid and cancelled orders. Unexpected legacy statuses are counted in an `unknown` bucket.
- **Average order value:** paid revenue / sales count, or zero if there are no qualifying sales.
- **Units sold / top products:** qualifying orders' saved item quantities. Product revenue is saved `items.price * items.quantity`, excludes shipping, and is grouped by saved product ID. No live Product lookup is needed; deleted/renamed products retain historical reporting. The latest matching order supplies the displayed snapshot name and SKU.
- **Paid order share:** qualifying sales count / all orders * 100. This is not a checkout conversion rate.
- **Dates:** `Order.createdAt`, not payment or delivery date. Asia/Manila calendar days, UTC+08:00, inclusive start/end dates translated to `[start, endExclusive)` UTC timestamps. Presets include today and the preceding N-1 days. Weeks start Monday; partial boundary weeks/months contain only orders within the selected range.
- **Currency:** PHP, following the existing admin UI. There is no per-order currency configuration.

Amounts are stored as JavaScript/MongoDB Numbers in the existing schema; report totals are rounded to two decimals. The original summary/trend remains a current-status operational report by order creation date, not a historical status snapshot. Delivery never marks payment paid. Administrators can now explicitly confirm delivered COD collections; see [cod-collection.md](cod-collection.md). Customer Management's spending metric still includes unpaid orders and will differ.

The additive `collections` section reports `totalRevenue`, `collectionCount`, and zero-filled `trend` rows (`date`, `revenue`, `collectionCount`) using **paidAt** within the same Asia/Manila date boundaries/grouping. It includes paid, non-cancelled COD orders with a recorded collection date, including shipping, irrespective of order creation date. Legacy paid orders without `paidAt` remain in original revenue metrics but are excluded from collection-date reporting; no dates are invented. New confirmations count each order once. The admin page shows this section separately even when no orders were created in the range. The two scans are operational reads, not a shared transactional report snapshot.

## API

`GET /api/admin/analytics` with `Authorization: Bearer <admin-token>`.

| Query                  | Allowed values                                   | Default |
| ---------------------- | ------------------------------------------------ | ------- |
| `range`                | `7d`, `30d`, `90d`, `custom`                     | `30d`   |
| `interval`             | `day`, `week`, `month`                           | `day`   |
| `startDate`, `endDate` | strict `YYYY-MM-DD`, required only with `custom` | none    |

Custom dates must be ordered, at most 366 inclusive days, and cannot end in the future. Explicit dates with a preset are rejected. Repeated/non-string filter inputs are rejected.

Examples:

```text
/api/admin/analytics?range=7d&interval=day
/api/admin/analytics?range=90d&interval=week
/api/admin/analytics?range=custom&startDate=2026-10-01&endDate=2026-10-07&interval=month
```

Illustrative response (one qualifying order; shortened arrays):

```json
{
  "filters": {
    "range": "custom",
    "interval": "day",
    "startDate": "2026-10-01",
    "endDate": "2026-10-01",
    "start": "2026-09-30T16:00:00.000Z",
    "endExclusive": "2026-10-01T16:00:00.000Z",
    "timezone": "Asia/Manila"
  },
  "currency": "PHP",
  "revenueBasis": "Explicitly paid, non-cancelled orders, grouped by order creation date. Includes shipping; product revenue excludes shipping.",
  "summary": {
    "totalOrders": 1,
    "totalRevenue": 225,
    "salesCount": 1,
    "unitsSold": 2,
    "averageOrderValue": 225,
    "paidOrderShare": 100
  },
  "ordersByStatus": [{ "status": "pending", "count": 1 }],
  "trend": [{ "date": "2026-10-01", "revenue": 225, "salesCount": 1 }],
  "topProducts": [
    {
      "productId": "0123456789abcdef01234567",
      "name": "Historical product",
      "sku": "SKU-1",
      "quantitySold": 2,
      "revenue": 200
    }
  ],
  "recentSales": [
    {
      "_id": "abcdef0123456789abcdef01",
      "createdAt": "2026-09-30T16:00:00.000Z",
      "total": 225,
      "orderStatus": "pending",
      "quantity": 2
    }
  ]
}
```

All five known order-status buckets are returned, including zeros. Trend buckets are zero-filled. Top products and recent sales are limited to 10 each. Status counters and order totals are calculated before item unwind to avoid double counting. Recent activity includes no user, address, credential, or payment-instrument fields. Responses use `Cache-Control: no-store`.

HTTP errors: 400 invalid filters, 401 absent/invalid authentication, 403 non-admin or revoked admin, 500 sanitized reporting/authorization failure.

## Performance / deployment

Requires MongoDB 5.0+ for `$dateTrunc`; integration tested with local MongoDB 7. Two independently date-filtered `$facet` aggregations run concurrently, each with a 15-second query limit: the original creation-date report and the additive collection-date report. No N+1 queries. `Order` declares `{ createdAt: -1, _id: -1 }` for global date scans, its existing customer-history index, and `{ paidAt: -1, _id: -1 }` with a partial filter for recorded collection dates. Follow the deployment's usual index creation process; no migration or application-data write is performed by this module. Inspect `explain("executionStats")` on representative data before introducing summary collections or further indexes. Facet grouping/sorting remains proportional to orders/items in the bounded range.

## Validation

From `admin/`:

```text
npm.cmd run build
npm.cmd run lint
```

From `server/`:

```text
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\tsx.cmd --test tests/adminAnalytics.test.ts tests/adminAnalytics.integration.test.ts tests/adminCustomer.test.ts
```

The integration suite requires `mongod` on PATH, or `MONGOD_BINARY` pointing to an installed binary. It starts a separate MongoDB bound to loopback on a random port with a fresh temporary dbpath, inserts synthetic fixtures, and removes only its own temporary files after shutdown. It does not load `.env`, use `MONGO_URI`, or touch the application's database. It covers actual revenue/quantity arithmetic, cancellation, absent/unpaid payment status, zero-value sales, Manila range edges, week/month buckets, empty periods, real JWT/admin guards, safe fields, and invalid requests.

## Manual checks

1. In Postman, use an existing admin token and run each example query. Verify `summary.totalRevenue` matches the sum of trend revenue, status counts sum to `totalOrders`, and item revenue excludes shipping. Use controlled test fixtures for paid/cancelled cases; do not alter production orders for testing.
2. Request without a token (401), with a normal user's token (403), invalid token (401), invalid date `2026-02-30` (400), reversed dates (400), future end date (400), an excessive range (400), and repeated query keys (400).
3. Open `/admin/analytics` after normal admin login. Apply all presets, each grouping, and a valid custom range. Check the chart tooltip/keyboard navigation and expandable exact-value table. Verify empty, unpaid-only, loading, retry, and expired-session states.
4. At desktop and mobile widths, verify KPI wrapping, filter controls, readable charts, and horizontal scrolling inside the two tables. Follow a recent-sale link to the existing order details.
5. Cancel a suitable order only in a controlled test environment, then return to analytics and verify the refreshed report. Order-status mutations invalidate analytics queries.
6. Recheck dashboard, products, customers, and inventory navigation. Analytics is loaded lazily, has cancellable requests and keys containing all applied filters, and discards its cache when unmounted.
