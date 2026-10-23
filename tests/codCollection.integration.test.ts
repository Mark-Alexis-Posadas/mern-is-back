import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";
import { Order, type IOrder } from "../src/models/order.model";
import { Product } from "../src/models/product.model";
import { User } from "../src/models/user.model";
import { Cart } from "../src/models/cart.model";
import adminOrders from "../src/routes/adminOrder.routes";
import { codCollectionErrors } from "../src/controllers/adminOrder.controller";
import customerOrders from "../src/routes/order.routes";
import {
  AdminAnalyticsService,
  parseAnalyticsQuery,
} from "../src/services/adminAnalytics.service";
import { AdminOrderService } from "../src/services/adminOrder.service";
import { OrderService } from "../src/services/order.service";
import { CartService } from "../src/services/cart.service";

const secret = "shopsphere-isolated-cod-collection-tests";
const previousSecret = process.env.JWT_SECRET;
let stop: (() => Promise<void>) | undefined;
let http: Server | undefined;
let base = "";
let adminId: string;
let customerId: string;
let productId: string;
const address = {
  fullName: "Fixture",
  phone: "09123456789",
  addressLine1: "Fixture Street",
  city: "Manila",
  province: "Metro Manila",
  postalCode: "1000",
};

before(
  async () => {
    stop = await startCartReplicaSet();
    await Promise.all([
      Order.createIndexes(),
      User.createIndexes(),
      Product.createIndexes(),
      Cart.createIndexes(),
    ]);
    process.env.JWT_SECRET = secret;
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminOrders);
    app.use("/api/orders", customerOrders);
    app.use("/api/admin/orders/:id/collect-cod", codCollectionErrors);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http!.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  },
  { timeout: 60_000 },
);

beforeEach(async () => {
  assert.equal(mongoose.connection.name, "cart_concurrency_test");
  await Promise.all([
    Order.deleteMany({}),
    User.deleteMany({}),
    Product.deleteMany({}),
    Cart.deleteMany({}),
  ]);
  const [admin, customer, product] = await Promise.all([
    User.create({
      name: "Fixture Admin",
      email: "admin@example.test",
      password: "fixture-not-a-password",
      isAdmin: true,
    }),
    User.create({
      name: "Fixture Customer",
      email: "customer@example.test",
      password: "fixture-not-a-password",
      isAdmin: false,
    }),
    Product.create({
      name: "Fixture Product",
      slug: "fixture",
      sku: "FIXTURE",
      description: "Fixture",
      category: "Test",
      price: 80,
      stock: 10,
    }),
  ]);
  adminId = String(admin._id);
  customerId = String(customer._id);
  productId = String(product._id);
});
after(async () => {
  mock.restoreAll();
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  if (stop) await stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function order(
  status: IOrder["orderStatus"] = "delivered",
  paymentStatus: IOrder["paymentStatus"] = "unpaid",
) {
  return Order.create({
    user: customerId,
    items: [
      {
        product: productId,
        name: "Historical Fixture",
        sku: "FIXTURE",
        price: 80,
        quantity: 3,
      },
    ],
    shippingAddress: address,
    paymentMethod: "COD",
    paymentStatus,
    orderStatus: status,
    subtotal: 240,
    shippingFee: 15,
    total: 255,
  });
}
function token(id = adminId, isAdmin = true) {
  return jwt.sign({ id, isAdmin }, secret, { expiresIn: "1h" });
}
async function request(
  path: string,
  bearer: string | undefined = token(),
  method = "POST",
  body: unknown = { confirmed: true },
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}
const path = (id: unknown) => `/api/admin/orders/${String(id)}/collect-cod`;
function filtersFor(date: Date) {
  const day = new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return parseAnalyticsQuery(
    { range: "custom", startDate: day, endDate: day },
    date,
  );
}

test("only a currently authorized administrator can confirm collection", async () => {
  const pending = await order();
  assert.equal((await request(path(pending._id), "")).status, 401);
  assert.equal((await request(path(pending._id), "invalid")).status, 401);
  assert.equal(
    (await request(path(pending._id), token(customerId, false))).status,
    403,
  );
  const old = token();
  await User.updateOne({ _id: adminId }, { $set: { isAdmin: false } });
  assert.equal((await request(path(pending._id), old)).status, 403);
  await User.deleteOne({ _id: adminId });
  assert.equal((await request(path(pending._id), old)).status, 401);
  assert.equal((await Order.findById(pending._id))!.paymentStatus, "unpaid");
});

test("explicit confirmation records current administrator, database time and server total without stock changes", async () => {
  const pending = await order();
  const before = await Product.findById(productId).lean();
  const start = Date.now();
  const response = await request(path(pending._id));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.order.paymentStatus, "paid");
  assert.equal(body.order.orderStatus, "delivered");
  assert.equal(body.order.total, 255);
  assert.equal(body.order.paymentCollectedBy, adminId);
  assert.ok(
    Date.parse(body.order.paidAt) >= start &&
      Date.parse(body.order.paidAt) <= Date.now(),
  );
  assert.deepEqual(await Product.findById(productId).lean(), before);
  const detail = await request(
    `/api/admin/orders/${String(pending._id)}`,
    token(),
    "GET",
  );
  const saved = await detail.json();
  assert.equal(saved.paymentCollectedBy, adminId);
  assert.equal(saved.paidAt, body.order.paidAt);
  const customer = await request(
    `/api/orders/${String(pending._id)}`,
    token(customerId, false),
    "GET",
  );
  const safe = await customer.json();
  assert.equal(safe.paymentStatus, "paid");
  assert.equal(safe.paymentCollectedBy, undefined);
  assert.equal(safe.paidAt, undefined);
});

test("invalid IDs, missing confirmation and client-authored amounts/audits are rejected safely", async () => {
  const pending = await order();
  assert.equal((await request(path("invalid"))).status, 400);
  assert.equal(
    (await request(path(new mongoose.Types.ObjectId()))).status,
    404,
  );
  for (const body of [
    null,
    [],
    {},
    { confirmed: false },
    { confirmed: "true" },
    { confirmed: true, total: 1 },
    { confirmed: true, paidAt: "2020-01-01" },
    { confirmed: true, paymentCollectedBy: customerId },
  ]) {
    const response = await request(path(pending._id), token(), "POST", body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).message, "string");
  }
  assert.equal((await Order.findById(pending._id))!.paymentStatus, "unpaid");
});

test("all ineligible fulfillment states and duplicate collections return controlled conflicts", async () => {
  for (const status of [
    "pending",
    "confirmed",
    "shipped",
    "cancelled",
  ] as const) {
    const pending = await order(status);
    assert.equal((await request(path(pending._id))).status, 409, status);
  }
  const nonCod = await order();
  await Order.collection.updateOne(
    { _id: nonCod._id },
    { $set: { paymentMethod: "legacy-other-method" } },
  );
  assert.equal((await request(path(nonCod._id))).status, 409);
  const legacy = await order("delivered", "paid");
  assert.equal((await request(path(legacy._id))).status, 409);
  assert.equal(
    (await Order.findById(legacy._id).select("+paidAt"))!.paidAt,
    undefined,
  );
  const pending = await order();
  assert.equal((await request(path(pending._id))).status, 200);
  const before = await Order.findById(pending._id)
    .select("+paidAt +paymentCollectedBy")
    .lean();
  assert.equal((await request(path(pending._id))).status, 409);
  assert.deepEqual(
    await Order.findById(pending._id)
      .select("+paidAt +paymentCollectedBy")
      .lean(),
    before,
  );
});

test("malformed and oversized confirmation JSON returns controlled parser errors", async () => {
  const pending = await order();
  for (const [body, status, message] of [
    ['{"confirmed":', 400, "A valid JSON collection confirmation is required."],
    [
      JSON.stringify({ confirmed: true, padding: "x".repeat(120_000) }),
      413,
      "Collection confirmation request is too large.",
    ],
  ] as const) {
    const response = await fetch(`${base}${path(pending._id)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token()}`,
      },
      body,
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { message });
  }
  assert.equal((await Order.findById(pending._id))!.paymentStatus, "unpaid");
});

test("unexpected collection failures return safe errors and leave payment unpaid", async () => {
  const pending = await order();
  const stub = mock.method(Order, "findOneAndUpdate", () => {
    throw new Error("private database diagnostics");
  });
  try {
    const response = await request(path(pending._id));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message:
        "Unable to confirm COD collection. Refresh the order before trying again.",
    });
  } finally {
    stub.mock.restore();
  }
  assert.equal((await Order.findById(pending._id))!.paymentStatus, "unpaid");
});

test(
  "overlapping administrators produce one collection and one immutable audit tuple",
  { timeout: 15_000 },
  async () => {
    const second = await User.create({
      name: "Other Admin",
      email: "other@example.test",
      password: "fixture",
      isAdmin: true,
    });
    const pending = await order();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const original = Order.findOneAndUpdate.bind(Order);
    const stub = mock.method(
      Order,
      "findOneAndUpdate",
      (...args: Parameters<typeof Order.findOneAndUpdate>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          if (++arrivals === 2) release();
          await barrier;
          return exec();
        };
        return query;
      },
    );
    let responses: Response[];
    try {
      responses = await Promise.all(
        [adminId, String(second._id)].map((id) =>
          request(path(pending._id), token(id)),
        ),
      );
      assert.equal(arrivals, 2);
    } finally {
      release();
      stub.mock.restore();
    }
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const winner = responses.findIndex((response) => response.status === 200);
    const saved = await Order.findById(pending._id).select(
      "+paidAt +paymentCollectedBy",
    );
    assert.equal(
      String(saved!.paymentCollectedBy),
      [adminId, String(second._id)][winner],
    );
    const report = await AdminAnalyticsService.report(
      filtersFor(saved!.paidAt!),
    );
    assert.equal(report.summary.totalRevenue, 255);
    assert.equal(report.collections.totalRevenue, 255);
    assert.equal(report.collections.collectionCount, 1);
    assert.equal(
      report.collections.trend.reduce(
        (sum, point) => sum + point.collectionCount,
        0,
      ),
      1,
    );
    assert.equal((await Product.findById(productId))!.stock, 10);
  },
);

test("delivery remains unpaid, generic updates cannot edit payment, and paid legacy orders cannot cancel", async () => {
  const pending = await order("shipped");
  const delivered = await request(
    `/api/admin/orders/${String(pending._id)}/status`,
    token(),
    "PATCH",
    {
      status: "delivered",
      paymentStatus: "paid",
      paidAt: new Date(),
      paymentCollectedBy: adminId,
    },
  );
  assert.equal(delivered.status, 200);
  assert.equal((await delivered.json()).order.paymentStatus, "unpaid");
  assert.equal(
    (await Order.findById(pending._id).select("+paidAt"))!.paidAt,
    undefined,
  );
  const paid = await order("pending", "paid");
  const before = await Product.findById(productId).lean();
  const response = await request(
    `/api/admin/orders/${String(paid._id)}/status`,
    token(),
    "PATCH",
    { status: "cancelled" },
  );
  assert.equal(response.status, 409);
  assert.equal((await Order.findById(paid._id))!.orderStatus, "pending");
  assert.deepEqual(await Product.findById(productId).lean(), before);
  const unpaid = await order("pending");
  assert.equal(
    (await AdminOrderService.updateOrderStatus(String(unpaid._id), "cancelled"))
      .result,
    "success",
  );
  assert.equal((await Product.findById(productId))!.stock, 13);
});

test("collection dates are independent of order creation, preserve legacy metrics and clip Manila boundaries", async () => {
  const pending = await order();
  await Order.collection.updateOne(
    { _id: pending._id },
    { $set: { createdAt: new Date("2020-01-01T00:00:00Z") } },
  );
  const response = await request(path(pending._id));
  assert.equal(response.status, 200);
  const paid = await response.json();
  const filters = filtersFor(new Date(paid.order.paidAt));
  const baseline = await AdminAnalyticsService.report(filters);
  assert.equal(baseline.summary.totalRevenue, 0);
  assert.equal(baseline.summary.totalOrders, 0);
  assert.equal(baseline.collections.totalRevenue, 255);
  const paidAt = filters.start;
  for (const [status, paymentStatus, timestamp] of [
    ["cancelled", "paid", paidAt],
    ["delivered", "unpaid", paidAt],
    ["delivered", "paid", new Date(filters.start.getTime() - 1)],
    ["delivered", "paid", filters.endExclusive],
  ] as const) {
    const fixture = await order(status, paymentStatus);
    await Order.collection.updateOne(
      { _id: fixture._id },
      { $set: { paidAt: timestamp } },
    );
  }
  await order("delivered", "paid"); // Legacy paid row: no invented collection date.
  const included = await order("delivered", "paid");
  await Order.collection.updateOne({ _id: included._id }, { $set: { paidAt } });
  for (const interval of ["day", "week", "month"] as const) {
    const report = await AdminAnalyticsService.report({ ...filters, interval });
    assert.equal(report.collections.totalRevenue, 510);
    assert.equal(report.collections.collectionCount, 2);
    assert.equal(
      report.collections.trend.reduce((sum, point) => sum + point.revenue, 0),
      510,
    );
  }
  const empty = await AdminAnalyticsService.report(
    parseAnalyticsQuery({
      range: "custom",
      startDate: "2010-01-01",
      endDate: "2010-01-02",
    }),
  );
  assert.equal(empty.collections.totalRevenue, 0);
  assert.equal(empty.collections.trend.length, 2);
});

test("existing COD checkout still creates an unpaid order without collection audit metadata", async () => {
  const cart = await CartService.saveOrUpdateCart(customerId, {
    cartId: null,
    version: 0,
    items: [{ product: productId, quantity: 1 }],
  });
  const created = await OrderService.createOrder(customerId, {
    cartId: cart._id,
    version: cart.version,
    shippingAddress: address,
    paymentMethod: "COD",
  });
  assert.equal(created.paymentStatus, "unpaid");
  assert.equal(created.paidAt, undefined);
  assert.equal(created.paymentCollectedBy, undefined);
  assert.equal((await Product.findById(productId))!.stock, 9);
});
