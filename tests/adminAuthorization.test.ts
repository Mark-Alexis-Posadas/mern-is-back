import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import jwt from "jsonwebtoken";
import { User } from "../src/models/user.model";
import orderRoutes from "../src/routes/adminOrder.routes";
import productRoutes from "../src/routes/adminProduct.routes";
import inventoryRoutes from "../src/routes/adminInventoryHistory.routes";
import customerRoutes from "../src/routes/adminCustomer.routes";
import analyticsRoutes from "../src/routes/adminAnalytics.routes";
import legacyProductRoutes from "../src/routes/product.routes";
import { AdminOrderService } from "../src/services/adminOrder.service";
import { AdminProductService } from "../src/services/adminProduct.service";
import { AdminInventoryService } from "../src/services/adminInventory.service";
import { AdminInventoryHistoryService } from "../src/services/adminInventoryHistory.service";
import { AdminCustomerService } from "../src/services/adminCustomer.service";
import { AdminAnalyticsService } from "../src/services/adminAnalytics.service";
import { ProductService } from "../src/services/product.service";

// Real JWT verification, route middleware, and controllers; only database/service
// boundaries are mocked. No .env loading, database connection, or fixture writes.
const secret = "shopsphere-authorization-regression-tests-only";
const previousSecret = process.env.JWT_SECRET;
const id = "abcdef012345abcdef012345";
const fixture = { _id: id, name: "Test fixture" };
let currentUser: { isAdmin: unknown } | null = { isAdmin: true };
let lookupFails = false;
let lookups = 0;
let handlerCalls = 0;
const result = (value: unknown) => async () => {
  handlerCalls++;
  return value;
};

const app = express();
app.use(express.json());
// Preserve the production mount order: the broad order router must not guard
// customer/product/inventory requests before their own router does.
app.use("/api/admin/analytics", analyticsRoutes);
app.use("/api/admin", orderRoutes);
app.use("/api/admin/customers", customerRoutes);
app.use("/api/admin/products", productRoutes);
app.use("/api/admin/inventory", inventoryRoutes);
app.use("/api/products", legacyProductRoutes);
const errors: ErrorRequestHandler = (_error: unknown, _req, res, _next) => {
  res.status(500).json({ message: "Internal server error" });
};
app.use(errors);
const server = app.listen(0, "127.0.0.1");

before(() => {
  process.env.JWT_SECRET = secret;
  mock.method(User, "findById", (userId: unknown) => {
    lookups++;
    assert.equal(userId, id);
    return {
      select: (projection: string) => {
        assert.equal(projection, "isAdmin");
        return {
          lean: async () => {
            if (lookupFails) throw new Error("private database details");
            return currentUser;
          },
        };
      },
    };
  });
  mock.method(AdminOrderService, "getAllOrders", result([fixture]));
  mock.method(AdminOrderService, "getOrderById", result(fixture));
  mock.method(
    AdminOrderService,
    "collectCodPayment",
    result({ result: "success", order: fixture }),
  );
  mock.method(
    AdminOrderService,
    "updateOrderStatus",
    result({ result: "success", order: fixture }),
  );
  mock.method(AdminProductService, "getAllProducts", result([fixture]));
  mock.method(AdminProductService, "getProductById", result(fixture));
  mock.method(AdminProductService, "createProduct", result(fixture));
  mock.method(AdminProductService, "updateProduct", result(fixture));
  mock.method(AdminProductService, "updateProductStatus", result(fixture));
  mock.method(
    AdminInventoryService,
    "adjustStock",
    result({ result: "success", newStock: 10 }),
  );
  mock.method(
    AdminInventoryHistoryService,
    "getMovements",
    result({ movements: [] }),
  );
  mock.method(AdminCustomerService, "list", result({ customers: [] }));
  mock.method(AdminCustomerService, "details", result({ customer: fixture }));
  mock.method(AdminAnalyticsService, "report", result({ revenue: 0 }));
  mock.method(ProductService, "createProduct", result(fixture));
  mock.method(ProductService, "updateProduct", result(fixture));
  mock.method(ProductService, "deleteProduct", result(fixture));
  mock.method(ProductService, "getAllProducts", result([fixture]));
  mock.method(ProductService, "getProductById", result(fixture));
  mock.method(console, "error", () => {});
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  mock.restoreAll();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

const endpoints: ReadonlyArray<readonly [string, string, number]> = [
  ["GET", "/api/admin/orders", 200],
  ["GET", `/api/admin/orders/${id}`, 200],
  ["PATCH", `/api/admin/orders/${id}/status`, 200],
  ["POST", `/api/admin/orders/${id}/collect-cod`, 200],
  ["GET", "/api/admin/products", 200],
  ["GET", `/api/admin/products/${id}`, 200],
  ["POST", "/api/admin/products", 201],
  ["PATCH", `/api/admin/products/${id}`, 200],
  ["PATCH", `/api/admin/products/${id}/status`, 200],
  ["PATCH", `/api/admin/products/${id}/stock`, 200],
  ["GET", "/api/admin/products/inventory/movements", 200],
  ["GET", "/api/admin/inventory/movements", 200],
  ["GET", "/api/admin/customers", 200],
  ["GET", `/api/admin/customers/${id}`, 200],
  ["GET", "/api/admin/analytics", 200],
  ["POST", "/api/products", 201],
  ["PATCH", `/api/products/${id}`, 200],
  ["DELETE", `/api/products/${id}`, 200],
];

function token(isAdmin: boolean, expiresIn = 3600) {
  return jwt.sign({ id, isAdmin }, secret, { expiresIn });
}

async function request(method: string, path: string, bearer?: string) {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  return fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      ...(method === "GET"
        ? {}
        : {
            body: JSON.stringify(
              path.endsWith("/collect-cod")
                ? { confirmed: true }
                : {
                    status: "confirmed",
                    isActive: true,
                    adjustment: 1,
                    reason: "Test adjustment",
                  },
            ),
          }),
    },
  );
}

test("every admin endpoint uses verified identity and current database privileges", async (t) => {
  const scenarios = [
    {
      name: "missing JWT",
      bearer: undefined,
      user: { isAdmin: true },
      status: 401,
      queries: 0,
    },
    {
      name: "invalid JWT",
      bearer: "invalid",
      user: { isAdmin: true },
      status: 401,
      queries: 0,
    },
    {
      name: "expired JWT",
      bearer: token(true, -1),
      user: { isAdmin: true },
      status: 401,
      queries: 0,
    },
    {
      name: "customer",
      bearer: token(false),
      user: { isAdmin: false },
      status: 403,
      queries: 1,
    },
    {
      name: "demoted administrator",
      bearer: token(true),
      user: { isAdmin: false },
      status: 403,
      queries: 1,
    },
    {
      name: "deleted administrator",
      bearer: token(true),
      user: null,
      status: 401,
      queries: 1,
    },
    {
      name: "current administrator",
      bearer: token(true),
      user: { isAdmin: true },
      status: 0,
      queries: 1,
    },
    {
      name: "current administrator with stale non-admin claim",
      bearer: token(false),
      user: { isAdmin: true },
      status: 0,
      queries: 1,
    },
    {
      name: "non-boolean database role",
      bearer: token(true),
      user: { isAdmin: "true" },
      status: 403,
      queries: 1,
    },
    {
      name: "database failure",
      bearer: token(true),
      user: { isAdmin: true },
      status: 500,
      queries: 1,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      currentUser = scenario.user;
      lookupFails = scenario.name === "database failure";
      for (const [method, path, successStatus] of endpoints) {
        lookups = 0;
        handlerCalls = 0;
        const response = await request(method, path, scenario.bearer);
        const context = `${scenario.name}: ${method} ${path}`;
        assert.equal(
          response.status,
          scenario.status || successStatus,
          context,
        );
        assert.equal(
          lookups,
          scenario.queries,
          `${context}: role lookup count`,
        );
        assert.equal(
          handlerCalls,
          scenario.status === 0 ? 1 : 0,
          `${context}: handler calls`,
        );
        const body: unknown = await response.json();
        assert.ok(!JSON.stringify(body).includes("private database details"));
        if (scenario.status === 401 && scenario.queries === 1) {
          assert.deepEqual(body, { message: "Authentication required" });
        }
        if (scenario.status === 403) {
          assert.deepEqual(body, { message: "Admin access required" });
        }
      }
    });
  }
});

test("role changes take effect on the next request with the same JWT", async () => {
  lookupFails = false;
  const bearer = token(true);
  currentUser = { isAdmin: true };
  assert.equal((await request("GET", "/api/admin/orders", bearer)).status, 200);
  currentUser = { isAdmin: false };
  assert.equal((await request("GET", "/api/admin/orders", bearer)).status, 403);
  currentUser = null;
  assert.equal((await request("GET", "/api/admin/orders", bearer)).status, 401);
});

test("malformed identity is rejected before querying MongoDB", async () => {
  lookups = 0;
  const bearer = jwt.sign({ id: "not-an-object-id", isAdmin: true }, secret);
  assert.equal((await request("GET", "/api/admin/orders", bearer)).status, 401);
  assert.equal(lookups, 0);
});

test("public product reads remain public and do not perform admin lookups", async () => {
  lookups = 0;
  for (const path of ["/api/products", `/api/products/${id}`]) {
    assert.equal((await request("GET", path)).status, 200);
  }
  assert.equal(lookups, 0);
});
