import assert from "node:assert/strict";
import { after, test, mock } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Types } from "mongoose";
import { AdminCustomerService, CustomerInputError, customerFilter, customerId, parseCustomerQuery } from "../src/services/adminCustomer.service";
import { getAdminCustomer, getAdminCustomers } from "../src/controllers/adminCustomer.controller";
import customerRoutes from "../src/routes/adminCustomer.routes";
import { Order } from "../src/models/order.model";
import { User } from "../src/models/user.model";
import { requireAdmin } from "../src/middleware/requireAdmin";
import type { AuthRequest } from "../src/middleware/auth.middleware";

test("pagination defaults, limits, and search normalization", () => {
  assert.deepEqual(parseCustomerQuery({}), { page: 1, limit: 10, search: "" });
  assert.deepEqual(parseCustomerQuery({ page: "2", limit: "100", search: "  Jane  " }), { page: 2, limit: 100, search: "Jane" });
  for (const value of ["0", "-1", "1.5", "1e2", "", " 2", ["1"], {}, "1000001", "9007199254740992"]) {
    assert.throws(() => parseCustomerQuery({ page: value }), CustomerInputError);
  }
  for (const value of ["101", "0", ["10"]]) assert.throws(() => parseCustomerQuery({ limit: value }), CustomerInputError);
  for (const value of [{ $ne: "" }, ["name"], "x".repeat(101)]) assert.throws(() => parseCustomerQuery({ search: value }), CustomerInputError);
});

test("customer IDs require exactly 24 hex characters", () => {
  assert.equal(String(customerId("abcdef012345abcdef012345")), "abcdef012345abcdef012345");
  for (const value of ["bad", "x".repeat(24), ["abcdef012345abcdef012345"], undefined]) assert.throws(() => customerId(value), CustomerInputError);
});

test("search is literal, case insensitive, and excludes admin accounts", () => {
  const filter = customerFilter("a+b@example.com (VIP)");
  assert.equal(filter.isAdmin, false);
  const nameSearch = filter.$or?.[0]?.name;
  assert.ok(nameSearch);
  const regex = new RegExp(nameSearch.$regex, nameSearch.$options);
  assert.ok(regex.test("A+B@example.com (VIP)"));
  assert.ok(!regex.test("aaab@exampleXcom VIP"));
});

const app = express();
// Exercise real authentication rejection without connecting to MongoDB.
app.use("/protected", customerRoutes);
app.get("/admin-check", (req: AuthRequest, _res, next) => {
  req.user = { id: "abcdef012345abcdef012345", isAdmin: true };
  next();
}, requireAdmin, (_req, res) => { res.json({ allowed: true }); });
// Controller-only routes allow deterministic failure tests with no database writes.
app.get("/customers", getAdminCustomers);
app.get("/customers/:id", getAdminCustomer);
const server = app.listen(0, "127.0.0.1");
after(() => { server.close(); });
async function request(path: string) {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
}

test("protected routes reject unauthenticated access", async () => {
  assert.equal((await request("/protected")).status, 401);
  assert.equal((await request("/protected/abcdef012345abcdef012345")).status, 401);
});

test("admin authorization checks the database even when token claims admin", async () => {
  const find = mock.method(User, "findById", () => ({
    select: () => ({ lean: async () => ({ isAdmin: false }) }),
  }));
  try {
    const response = await request("/admin-check");
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { message: "Admin access required" });
  } finally { find.mock.restore(); }
});

test("controllers reject malformed input before querying MongoDB", async () => {
  for (const path of ["/customers?page=0", "/customers?page=1&page=2", "/customers?limit=101", "/customers?search=" + "x".repeat(101), "/customers/invalid"]) {
    const response = await request(path);
    assert.equal(response.status, 400, path);
    assert.equal(typeof (await response.json()).message, "string");
  }
});

test("details returns 404 for missing customers and sanitizes unexpected errors", async () => {
  const stub = mock.method(AdminCustomerService, "details", async () => null);
  try {
    const missing = await request("/customers/abcdef012345abcdef012345");
    assert.equal(missing.status, 404);
    stub.mock.mockImplementation(async () => { throw new Error("private database details"); });
    const failure = await request("/customers/abcdef012345abcdef012345");
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { message: "Unable to fetch customer information." });
  } finally { stub.mock.restore(); }
});

test("list batches order summaries, projects safe fields, and defaults zero-order customers", async () => {
  const first = new Types.ObjectId();
  const second = new Types.ObjectId();
  const projection = { _id: 1, name: 1, email: 1, createdAt: 1 };
  const customers = [{ _id: first, name: "Jane", email: "jane@example.com", createdAt: new Date() }, { _id: second, name: "Jo", email: "jo@example.com", createdAt: new Date() }];
  const chain = {
    sort: () => chain, skip: () => chain, limit: () => chain,
    lean: async () => customers,
  };
  const find = mock.method(User, "find", (filter: unknown, fields: unknown) => {
    assert.deepEqual(filter, { isAdmin: false });
    assert.deepEqual(fields, projection);
    return chain;
  });
  const count = mock.method(User, "countDocuments", async () => 2);
  const aggregate = mock.method(Order, "aggregate", async (pipeline: unknown) => {
    assert.deepEqual(pipeline, [
      { $match: { user: { $in: [first, second] } } },
      { $group: {
        _id: "$user", orderCount: { $sum: 1 },
        totalSpending: { $sum: { $cond: [{ $ne: ["$orderStatus", "cancelled"] }, "$total", 0] } },
        cancelledOrderCount: { $sum: { $cond: [{ $eq: ["$orderStatus", "cancelled"] }, 1, 0] } },
      } },
    ]);
    return [{ _id: first, orderCount: 3, totalSpending: 750, cancelledOrderCount: 1 }];
  });
  try {
    const result = await AdminCustomerService.list({ page: 1, limit: 10, search: "" });
    assert.equal(aggregate.mock.callCount(), 1);
    assert.equal(result.customers[0]?.orderCount, 3);
    assert.equal(result.customers[0]?.totalSpending, 750);
    assert.equal(result.customers[1]?.orderCount, 0);
    assert.equal(result.customers[1]?.totalSpending, 0);
    assert.deepEqual(result.pagination, { page: 1, limit: 10, total: 2, totalPages: 1 });
  } finally { find.mock.restore(); count.mock.restore(); aggregate.mock.restore(); }
});
