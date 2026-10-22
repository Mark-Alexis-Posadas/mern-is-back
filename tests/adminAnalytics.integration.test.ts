import assert from "node:assert/strict";
import { after, before, test, mock } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer, type AddressInfo, type Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose, { Types } from "mongoose";
import { Order, type IOrder } from "../src/models/order.model";
import { User } from "../src/models/user.model";
import {
  AdminAnalyticsService,
  parseAnalyticsQuery,
} from "../src/services/adminAnalytics.service";
import analyticsRoutes from "../src/routes/adminAnalytics.routes";

// This suite starts its OWN MongoDB on a random loopback port and a fresh temp dbpath.
// It never reads MONGO_URI, loads .env, or connects to the application's database.
let mongo: ChildProcess | undefined;
let directory: string | undefined;
let http: HttpServer | undefined;
let baseUrl = "";
const previousSecret = process.env.JWT_SECRET;
const secret = "shopsphere-isolated-analytics-tests-only";
const adminId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const productA = new Types.ObjectId();
const productB = new Types.ObjectId();
const now = new Date("2026-10-21T00:00:00Z");
const filters = (interval = "day") =>
  parseAnalyticsQuery(
    {
      range: "custom",
      startDate: "2026-10-01",
      endDate: "2026-10-07",
      interval,
    },
    now,
  );

async function freePort() {
  const socket: Server = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}

before(
  async () => {
    directory = await mkdtemp(join(tmpdir(), "shopsphere-analytics-test-"));
    await mkdir(join(directory, "db"));
    const port = await freePort();
    mongo = spawn(
      process.env.MONGOD_BINARY ?? "mongod",
      [
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--dbpath",
        join(directory, "db"),
        "--logpath",
        join(directory, "mongo.log"),
        "--setParameter",
        "diagnosticDataCollectionEnabled=false",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let spawnError: Error | undefined;
    mongo.on("error", (error) => {
      spawnError = error;
    });
    let connected = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (mongo.exitCode !== null)
        throw new Error("Isolated MongoDB exited during startup.");
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/analytics_test`, {
          serverSelectionTimeoutMS: 500,
          autoIndex: false,
        });
        connected = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    assert.ok(
      connected,
      "The isolated MongoDB must start; install mongod or set MONGOD_BINARY.",
    );
    await User.collection.insertMany([
      {
        _id: adminId,
        name: "Test Admin",
        email: "admin@example.test",
        password: "test-fixture-not-a-real-credential",
        isAdmin: true,
      },
      {
        _id: customerId,
        name: "Test Customer",
        email: "customer@example.test",
        password: "test-fixture-not-a-real-credential",
        isAdmin: false,
      },
    ]);
    const address = {
      fullName: "Fixture",
      phone: "000",
      addressLine1: "Test",
      city: "Test",
      province: "Test",
      postalCode: "0000",
    };
    const itemA = (price: number, quantity: number) => ({
      product: productA,
      name: "Historical A",
      sku: "OLD-A",
      price,
      quantity,
    });
    const itemB = (price: number, quantity: number) => ({
      product: productB,
      name: "Historical B",
      sku: "OLD-B",
      price,
      quantity,
    });
    function order(
      createdAt: string,
      total: number,
      status: IOrder["orderStatus"],
      paymentStatus: IOrder["paymentStatus"],
      items = [itemA(total, 1)],
    ) {
      return {
        _id: new Types.ObjectId(),
        user: customerId,
        createdAt: new Date(createdAt),
        total,
        subtotal: total,
        shippingFee: 0,
        orderStatus: status,
        paymentStatus,
        paymentMethod: "COD" as const,
        shippingAddress: address,
        items,
      };
    }
    const missingPayment = order(
      "2026-10-05T00:00:00Z",
      500,
      "delivered",
      "unpaid",
    );
    const { paymentStatus: _omittedPayment, ...legacy } = missingPayment;
    await Order.collection.insertMany([
      {
        ...order("2026-09-30T16:00:00Z", 225, "pending", "paid", [
          itemA(100, 2),
        ]),
        subtotal: 200,
        shippingFee: 25,
      },
      order("2026-10-07T15:59:59.999Z", 80, "delivered", "paid", [
        itemA(10, 3),
        itemB(25, 2),
      ]),
      order("2026-10-03T00:00:00Z", 999, "cancelled", "paid"),
      order("2026-10-04T00:00:00Z", 400, "delivered", "unpaid"),
      legacy,
      order("2026-09-30T15:59:59.999Z", 600, "delivered", "paid"),
      order("2026-10-07T16:00:00Z", 700, "delivered", "paid"),
      order("2026-10-06T00:00:00Z", 0, "confirmed", "paid", [itemB(0, 1)]),
    ]);
    process.env.JWT_SECRET = secret;
    const app = express();
    app.use("/api/admin/analytics", analyticsRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => http!.once("listening", done));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/admin/analytics`;
  },
  { timeout: 40_000 },
);

after(async () => {
  if (http) await new Promise<void>((done) => http!.close(() => done()));
  await mongoose.disconnect();
  if (mongo?.pid && mongo.exitCode === null) {
    const exited = new Promise<void>((done) =>
      mongo!.once("exit", () => done()),
    );
    mongo.kill();
    await exited;
  }
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
  if (directory) {
    const target = resolve(directory);
    const temporaryRoot = resolve(tmpdir()) + sep;
    assert.ok(
      target.startsWith(temporaryRoot) &&
        target
          .slice(temporaryRoot.length)
          .startsWith("shopsphere-analytics-test-"),
    );
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("actual aggregation counts orders once and excludes cancelled/unpaid/missing-payment revenue", async () => {
  const report = await AdminAnalyticsService.report(filters());
  assert.deepEqual(report.summary, {
    totalOrders: 6,
    totalRevenue: 305,
    salesCount: 3,
    unitsSold: 8,
    averageOrderValue: 101.67,
    paidOrderShare: 50,
  });
  assert.equal(
    report.ordersByStatus.reduce((sum, row) => sum + row.count, 0),
    6,
  );
  assert.equal(
    report.ordersByStatus.find((row) => row.status === "cancelled")?.count,
    1,
  );
  assert.equal(report.trend.length, 7);
  assert.equal(report.trend[0]?.revenue, 225);
  assert.equal(report.trend[6]?.revenue, 80);
  assert.equal(
    report.trend.reduce((sum, row) => sum + row.revenue, 0),
    305,
  );
});

test("historical product prices and quantities survive without Product records; shipping is not item revenue", async () => {
  const report = await AdminAnalyticsService.report(filters());
  assert.deepEqual(
    report.topProducts.map(({ name, sku, quantitySold, revenue }) => ({
      name,
      sku,
      quantitySold,
      revenue,
    })),
    [
      { name: "Historical A", sku: "OLD-A", quantitySold: 5, revenue: 230 },
      { name: "Historical B", sku: "OLD-B", quantitySold: 3, revenue: 50 },
    ],
  );
  assert.equal(report.recentSales.length, 3);
  assert.equal(report.recentSales[0]?.total, 80);
  assert.deepEqual(Object.keys(report.recentSales[0]!).sort(), [
    "_id",
    "createdAt",
    "orderStatus",
    "quantity",
    "total",
  ]);
});

test("MongoDB weekly/monthly grouping matches Manila zero filling and clips partial buckets", async () => {
  const weekly = await AdminAnalyticsService.report(filters("week"));
  assert.deepEqual(weekly.trend, [
    { date: "2026-09-28", revenue: 225, salesCount: 1 },
    { date: "2026-10-05", revenue: 80, salesCount: 2 },
  ]);
  const monthly = await AdminAnalyticsService.report(filters("month"));
  assert.deepEqual(monthly.trend, [
    { date: "2026-10-01", revenue: 305, salesCount: 3 },
  ]);
});

test("empty database interval returns zeros, complete status buckets, and zero-filled trends", async () => {
  const empty = await AdminAnalyticsService.report(
    parseAnalyticsQuery(
      { range: "custom", startDate: "2020-01-01", endDate: "2020-01-02" },
      now,
    ),
  );
  assert.deepEqual(empty.summary, {
    totalOrders: 0,
    totalRevenue: 0,
    salesCount: 0,
    unitsSold: 0,
    averageOrderValue: 0,
    paidOrderShare: 0,
  });
  assert.equal(
    empty.ordersByStatus.every((row) => row.count === 0),
    true,
  );
  assert.deepEqual(empty.topProducts, []);
  assert.deepEqual(empty.recentSales, []);
  assert.deepEqual(empty.trend, [
    { date: "2020-01-01", revenue: 0, salesCount: 0 },
    { date: "2020-01-02", revenue: 0, salesCount: 0 },
  ]);
});

test("real JWT/admin middleware rejects missing, invalid, non-admin and stale-admin tokens", async () => {
  assert.equal((await fetch(baseUrl)).status, 401);
  assert.equal(
    (await fetch(baseUrl, { headers: { Authorization: "Bearer invalid" } }))
      .status,
    401,
  );
  for (const isAdmin of [false, true]) {
    const token = jwt.sign({ id: String(customerId), isAdmin }, secret, {
      expiresIn: "1h",
    });
    assert.equal(
      (await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } }))
        .status,
      403,
    );
  }
});

test("authorized endpoint validates filters and returns a safe, no-store report", async () => {
  const token = jwt.sign({ id: String(adminId), isAdmin: true }, secret, {
    expiresIn: "1h",
  });
  const headers = { Authorization: `Bearer ${token}` };
  const response = await fetch(
    `${baseUrl}?range=custom&startDate=2026-10-01&endDate=2026-10-07`,
    { headers },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json();
  assert.equal(report.summary.totalRevenue, 305);
  assert.equal(report.currency, "PHP");
  for (const forbidden of ["password", "shippingAddress", "email", "token"])
    assert.ok(!JSON.stringify(report).includes(`"${forbidden}"`));
  assert.equal(
    (
      await fetch(
        `${baseUrl}?range=custom&startDate=2026-02-30&endDate=2026-03-01`,
        { headers },
      )
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}?range=7d&range=90d`, { headers })).status,
    400,
  );
});

test("authorization database failures return sanitized JSON rather than stack traces", async () => {
  const find = mock.method(User, "findById", () => {
    throw new Error("private-database-diagnostics");
  });
  try {
    const token = jwt.sign({ id: String(adminId), isAdmin: true }, secret, {
      expiresIn: "1h",
    });
    const response = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message: "Unable to authenticate. Please try again.",
    });
  } finally {
    find.mock.restore();
  }
});
