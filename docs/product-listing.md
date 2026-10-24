# Storefront product discovery

GET /api/products now always returns a paginated envelope, including when no
query parameters are present:

```json
{ "items": [], "total": 0, "page": 1, "limit": 12, "totalPages": 0 }
```

Items retain existing Product fields. The only in-repository storefront consumer
was migrated with the endpoint. Admin uses /api/admin/products and is unchanged.
External consumers expecting a bare array must migrate and deploy with this change.
GET /api/products/:id remains unchanged. No stock, cart, checkout, or payment rules
are changed; checkout remains COD only.

## Parameters

- search: trimmed literal case-insensitive substring of name, SKU or brand, up to
  80 characters. Regex metacharacters are escaped, never interpreted as patterns.
- category: exact, case-sensitive existing category string, up to 150 characters.
- minPrice / maxPrice: inclusive nonnegative decimal PHP amounts, up to two decimal
  places and 1,000,000,000; minimum cannot exceed maximum.
- sort: newest (default), priceAsc, priceDesc, nameAsc, nameDesc. Name sorts use
  MongoDB binary ordering, not locale collation. All sorts include _id tie-breakers.
- page: positive integer up to 10,000, default 1. Offset must not exceed 10,000.
- limit: positive integer up to 48, default 12.

Unknown, repeated, structured and invalid values return safe 400 JSON errors.
Only active products are visible; zero-stock active products remain visible.
Out-of-range pages return empty items with the real count. Empty catalogs have
zero totalPages. Item and count queries run concurrently and can briefly differ
when products are being edited; this endpoint does not take a catalog snapshot.

## Performance and deployment

Added active+createdAt+_id, active+price+_id and active+name+_id indexes support
normal listing sorts, with reverse scans for descending name/price. The existing
active+category+createdAt index is extended with _id. No indexes are built or
removed by this task against production. Use the deployment's normal index rollout
and review redundant older category indexes; do not run destructive syncIndexes.

Literal substring search does not use the existing text index and may scan active
candidates. Both queries use maxTimeMS(3000); input and offset bounds limit work.
This is bounded database pagination, not unlimited full-text search scalability.
For catalogs that exceed this budget, measure explain executionStats and adopt a
search-specific indexed strategy in a separately scoped task. Avoid adding every
possible category/price/sort compound index without measurements.

## Storefront behavior and verification

Search commits after 350 ms of inactivity. Category and prices apply together;
sort and pagination apply immediately. All effective filters are in TanStack Query
keys and URLs; filter changes reset page 1. Browser history restores URL state and
product cards carry a safe listing return URL to detail breadcrumbs. Pending
requests receive abort signals; results from other filter keys are never displayed
as current results. Filter controls use native labels, keyboard inputs and buttons.

Manually verify search, exact category, price equality/range, all sorts, page links,
reset, empty results and retry after a failed request. Share a filtered URL and use
browser back/forward, then open details and return through the Products breadcrumb.
Test mobile layout and keyboard focus. Confirm adding from details and COD checkout
still work. Automated UI checks use SSR and memory-router history, not a real browser.
