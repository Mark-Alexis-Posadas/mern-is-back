import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Order } from "../src/models/order.model";
import { User } from "../src/models/user.model";
import { Product } from "../src/models/product.model";
import { InventoryMovement } from "../src/models/inventoryMovement.model";
import orderRoutes from "../src/routes/order.routes";
import {
  parseCustomerOrderQuery,
  CustomerOrderQueryError,
} from "../src/services/customerOrderList.query";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";

let stop: (() => Promise<void>) | undefined, http: Server | undefined;
let base = "",
  owner = "",
  other = "",
  productId = "",
  pendingId = "",
  paidId = "";
const secret = "isolated-customer-order-list-test";
const previousSecret = process.env.JWT_SECRET;
const statuses = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
] as const;
before(
  async () => {
    stop = await startCartReplicaSet();
    assert.equal(mongoose.connection.name, "cart_concurrency_test");
    await Promise.all([
      Order.createIndexes(),
      User.createIndexes(),
      Product.createIndexes(),
      InventoryMovement.createIndexes(),
    ]);
    process.env.JWT_SECRET = secret;
    const users = await User.create([
      { name: "Owner", email: "owner@example.test", password: "fixture" },
      { name: "Other", email: "other@example.test", password: "fixture" },
    ]);
    owner = String(users[0]!._id);
    other = String(users[1]!._id);
    const product = await Product.create({
      name: "Fixture",
      sku: "LIST",
      slug: "list",
      description: "Fixture",
      category: "Home",
      price: 10,
      stock: 0,
    });
    productId = String(product._id);
    const rows = await Order.insertMany(
      [
        ...statuses.map((orderStatus) => ({
          user: owner,
          orderStatus,
          paymentStatus: orderStatus === "delivered" ? "paid" : "unpaid",
        })),
        { user: other, orderStatus: "pending", paymentStatus: "unpaid" },
      ].map((row) => ({
        ...row,
        paymentMethod: "COD",
        items: [
          {
            product: product._id,
            name: "Fixture",
            sku: "LIST",
            price: 10,
            quantity: 1,
          },
        ],
        shippingAddress: {
          fullName: "Fixture",
          phone: "09123456789",
          addressLine1: "Fixture",
          city: "Manila",
          province: "Manila",
          postalCode: "1000",
        },
        subtotal: 10,
        shippingFee: 0,
        total: 10,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        paidAt: new Date("2026-01-02T00:00:00Z"),
        paymentCollectedBy: users[1]!._id,
      })),
    );
    pendingId = String(rows[0]!._id);
    paidId = String(rows[3]!._id);
    await Order.collection.updateMany(
      {},
      { $set: { internalInventoryAudit: "private-fixture" } },
    );
    const app = express();
    app.use(express.json());
    app.use("/api/orders", orderRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http!.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/orders`;
  },
  { timeout: 60000 },
);
after(async () => {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  if (stop) await stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
const token = (id: string) => jwt.sign({ id, isAdmin: false }, secret);
async function request(
  path: string,
  id = owner,
  method = "GET",
  body?: unknown,
) {
  return fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(id ? { Authorization: "Bearer " + token(id) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function list(query = "", id = owner) {
  const response = await request("/my" + query, id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json() as Promise<{
    items: {
      _id: string;
      user: string;
      orderStatus: string;
      paymentStatus: string;
    }[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>;
}
test("authenticated history scopes both rows and counts to current account and excludes all admin audit metadata", async () => {
  assert.equal((await request("/my", "")).status, 401);
  const response = await list();
  assert.equal(response.total, 5);
  assert.equal(response.page, 1);
  assert.equal(response.limit, 10);
  assert.equal(response.totalPages, 1);
  assert.ok(response.items.every((row) => row.user === owner));
  const serialized = JSON.stringify(response);
  for (const field of [
    "paidAt",
    "paymentCollectedBy",
    "internalInventoryAudit",
  ])
    assert.ok(!serialized.includes(field));
  const others = await list("", other);
  assert.equal(others.total, 1);
  assert.ok(others.items.every((row) => row.user === other));
  assert.equal((await request("/my?user=" + other)).status, 400);
});
test("fulfillment and payment filters compose without crossing customer boundaries", async () => {
  for (const status of statuses) {
    const result = await list("?orderStatus=" + status);
    assert.equal(result.total, 1);
    assert.equal(result.items[0]!.orderStatus, status);
  }
  assert.equal((await list("?paymentStatus=paid")).total, 1);
  assert.equal((await list("?paymentStatus=unpaid")).total, 4);
  assert.equal(
    (await list("?orderStatus=pending&paymentStatus=paid")).total,
    0,
  );
});
test("identical timestamps paginate stably in newest and oldest order", async () => {
  for (const sort of ["newest", "oldest"]) {
    const all = await list("?sort=" + sort),
      ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await list(`?sort=${sort}&page=${page}&limit=2`);
      assert.equal(result.totalPages, 3);
      ids.push(...result.items.map((row) => row._id));
    }
    assert.deepEqual(
      ids,
      all.items.map((row) => row._id),
    );
    assert.equal(new Set(ids).size, 5);
    assert.deepEqual(
      ids,
      sort === "oldest" ? [...ids].sort() : [...ids].sort().reverse(),
    );
  }
});
test("invalid pagination, statuses, structured selectors and repeated parameters return controlled 400", async () => {
  for (const query of [
    "page=0",
    "page=-1",
    "page=1.1",
    "page=10001",
    "page=1000&limit=50",
    "limit=51",
    "limit=NaN",
    "limit=0",
    "page=1&page=2",
    "orderStatus=unknown",
    "paymentStatus=refunded",
    "sort=name",
    "orderStatus[$ne]=cancelled",
    "paymentStatus=paid&paymentStatus=unpaid",
    "userId=" + other,
  ]) {
    const response = await request("/my?" + query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).message, "string");
  }
  for (const value of [null, [], {}, 1])
    assert.throws(
      () => parseCustomerOrderQuery({ orderStatus: value }),
      CustomerOrderQueryError,
    );
});
test("empty and out-of-range pages preserve accurate customer totals", async () => {
  const empty = await list("?orderStatus=confirmed&paymentStatus=paid");
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 0);
  const beyond = await list("?page=10");
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 5);
});
test("history migration preserves customer details and transactional cancellation contracts", async () => {
  assert.equal((await request("/" + pendingId, other)).status, 404);
  const paidDetail = await (await request("/" + paidId)).json();
  assert.equal(paidDetail.paymentStatus, "paid");
  assert.equal(paidDetail.paidAt, undefined);
  assert.equal(paidDetail.paymentCollectedBy, undefined);
  assert.equal(
    (
      await request("/" + pendingId + "/cancel", other, "POST", {
        confirmed: true,
      })
    ).status,
    404,
  );
  const cancel = await request("/" + pendingId + "/cancel", owner, "POST", {
    confirmed: true,
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).orderStatus, "cancelled");
  assert.equal((await list("?orderStatus=cancelled")).total, 2);
  assert.equal((await Product.findById(productId))!.stock, 1);
  assert.equal(
    await InventoryMovement.countDocuments({ type: "cancellation" }),
    1,
  );
  assert.equal(
    (
      await request("/" + pendingId + "/cancel", owner, "POST", {
        confirmed: true,
      })
    ).status,
    409,
  );
});
