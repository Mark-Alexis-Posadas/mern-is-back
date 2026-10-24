export class ProductQueryError extends Error {}
export const PRODUCT_SORTS = [
  "newest",
  "priceAsc",
  "priceDesc",
  "nameAsc",
  "nameDesc",
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export interface ProductListQuery {
  search: string;
  category: string;
  minPrice?: number;
  maxPrice?: number;
  sort: ProductSort;
  page: number;
  limit: number;
}
export function parseProductQuery(
  input: Record<string, unknown>,
): ProductListQuery {
  const allowed = new Set([
    "search",
    "category",
    "minPrice",
    "maxPrice",
    "sort",
    "page",
    "limit",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new ProductQueryError("Unsupported product filter.");
  const text = (key: string, max: number) => {
    const value = input[key];
    if (value === undefined) return "";
    if (
      typeof value !== "string" ||
      value.length > max ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      throw new ProductQueryError(`Invalid ${key}.`);
    return value.trim();
  };
  const integer = (key: string, fallback: number, max: number) => {
    if (input[key] === undefined) return fallback;
    const value = text(key, 8);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
      throw new ProductQueryError(`Invalid ${key}.`);
    return Number(value);
  };
  const price = (key: string) => {
    if (input[key] === undefined) return undefined;
    const value = text(key, 16);
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 1_000_000_000)
      throw new ProductQueryError(`Invalid ${key}.`);
    return Number(value);
  };
  const sort = text("sort", 12) || "newest";
  if (!PRODUCT_SORTS.includes(sort as ProductSort))
    throw new ProductQueryError("Invalid sort.");
  const page = integer("page", 1, 10000),
    limit = integer("limit", 12, 48);
  // Bound offset work; larger catalogs should use cursor pagination.
  if ((page - 1) * limit > 10000)
    throw new ProductQueryError(
      "Page exceeds the supported browsing range. Narrow your filters.",
    );
  const minPrice = price("minPrice"),
    maxPrice = price("maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)
    throw new ProductQueryError("Minimum price cannot exceed maximum price.");
  return {
    search: text("search", 80),
    category: text("category", 150),
    minPrice,
    maxPrice,
    sort: sort as ProductSort,
    page,
    limit,
  };
}
export function escapeProductSearch(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
