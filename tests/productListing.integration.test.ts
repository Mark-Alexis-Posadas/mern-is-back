import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import mongoose from "mongoose";
import { Product } from "../src/models/product.model";
import productRoutes from "../src/routes/product.routes";
import {
  parseProductQuery,
  escapeProductSearch,
  ProductQueryError,
} from "../src/services/productList.query";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";

let stop: (() => Promise<void>) | undefined;
let http: Server | undefined;
let base = "";
let activeId = "";
let inactiveId = "";
before(
  async () => {
    stop = await startCartReplicaSet();
    assert.equal(mongoose.connection.name, "cart_concurrency_test");
    await Product.createIndexes();
    const products = await Product.insertMany(
      [
        {
          name: "Alpha [A+]",
          sku: "ALPHA",
          price: 10,
          category: "Home",
          brand: "Acme",
          isActive: true,
        },
        {
          name: "Bravo",
          sku: "BRAVO",
          price: 20,
          category: "Home",
          brand: "Acme",
          isActive: true,
        },
        {
          name: "Charlie",
          sku: "CHARLIE",
          price: 20,
          category: "Tech",
          brand: "Other",
          isActive: true,
        },
        {
          name: "Delta",
          sku: "DELTA",
          price: 30,
          category: "Tech",
          brand: "Other",
          isActive: true,
        },
        {
          name: "Hidden Alpha",
          sku: "HIDDEN",
          price: 15,
          category: "Hidden",
          brand: "Acme",
          isActive: false,
        },
      ].map((item, index) => ({
        ...item,
        slug: "listing-fixture-" + index,
        description: "Fixture",
        stock: index,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })),
    );
    activeId = String(products[0]!._id);
    inactiveId = String(products[4]!._id);
    const app = express();
    app.use("/api/products", productRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http!.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/products`;
  },
  { timeout: 60000 },
);
after(async () => {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  if (stop) await stop();
});
async function list(query = "") {
  const response = await fetch(base + query);
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    items: {
      _id: string;
      name: string;
      price: number;
      isActive: boolean;
      stock: number;
    }[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>;
}
test("public listing is active-only, paginated by default, and preserves out-of-stock/detail visibility", async () => {
  const result = await list();
  assert.equal(result.total, 4);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 12);
  assert.equal(result.totalPages, 1);
  assert.ok(result.items.every((item) => item.isActive));
  assert.equal(result.items.find((item) => item._id === activeId)!.stock, 0);
  const detail = await fetch(base + "/" + activeId);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json())._id, activeId);
  assert.equal((await fetch(base + "/" + inactiveId)).status, 404);
});
test("search matches literal names, SKU, and brands case-insensitively; regex payloads cannot widen results", async () => {
  for (const [search, expected] of [
    ["alpha", 1],
    ["rAvO", 1],
    ["acme", 2],
    ["[A+]", 1],
    ["not-found", 0],
    [".*", 0],
    ["$ne", 0],
    ["(a+)+$", 0],
  ] as const) {
    assert.equal(
      (await list("?search=" + encodeURIComponent(search))).total,
      expected,
      search,
    );
  }
  for (const char of ".*+?^${}()|[]\\")
    assert.equal(escapeProductSearch(char), "\\" + char);
});
test("category is exact and price boundaries are inclusive and composable", async () => {
  assert.equal((await list("?category=Home")).total, 2);
  assert.equal((await list("?category=home")).total, 0);
  assert.equal((await list("?minPrice=20&maxPrice=20")).total, 2);
  assert.equal((await list("?category=Home&minPrice=20&search=acme")).total, 1);
  assert.equal((await list("?minPrice=0&maxPrice=0")).total, 0);
});
test("all five sorts are correct and equal-key pagination has no duplicate or missing products", async () => {
  for (const sort of [
    "newest",
    "priceAsc",
    "priceDesc",
    "nameAsc",
    "nameDesc",
  ]) {
    const all = await list("?sort=" + sort + "&limit=4");
    const first = await list("?sort=" + sort + "&limit=2&page=1");
    const second = await list("?sort=" + sort + "&limit=2&page=2");
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item._id),
      all.items.map((item) => item._id),
    );
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item._id)).size,
      4,
    );
    const direction = sort.endsWith("Desc") || sort === "newest" ? -1 : 1;
    for (let index = 1; index < all.items.length; index++) {
      const a = all.items[index - 1]!,
        b = all.items[index]!;
      const compare = sort.startsWith("price")
        ? a.price - b.price
        : sort.startsWith("name")
          ? a.name < b.name
            ? -1
            : a.name === b.name
              ? 0
              : 1
          : 0;
      assert.ok((compare || (a._id < b._id ? -1 : 1)) * direction <= 0);
    }
  }
  const beyond = await list("?page=20");
  assert.equal(beyond.total, 4);
  assert.deepEqual(beyond.items, []);
});
test("malformed, repeated, structured, unbounded and unknown query parameters return safe 400s", async () => {
  for (const query of [
    "page=0",
    "page=-1",
    "page=1.5",
    "page=10001",
    "page=1000&limit=48",
    "limit=49",
    "limit=0",
    "limit=NaN",
    "minPrice=-1",
    "maxPrice=Infinity",
    "minPrice=1e2",
    "minPrice=0.001",
    "minPrice=30&maxPrice=10",
    "sort=stock",
    "search=a&search=b",
    "search[$ne]=a",
    "category[$ne]=a",
    "minPrice[$gt]=1",
    "search=" + "a".repeat(81),
  ]) {
    const response = await fetch(base + "?" + query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).message, "string");
  }
  for (const value of [null, [], {}, 5])
    assert.throws(
      () => parseProductQuery({ search: value }),
      ProductQueryError,
    );
  assert.equal(parseProductQuery({ search: "  Alpha  " }).search, "Alpha");
});
