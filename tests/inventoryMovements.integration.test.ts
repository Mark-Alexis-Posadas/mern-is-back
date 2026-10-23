import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";
import { InventoryMovement } from "../src/models/inventoryMovement.model";
import { Product } from "../src/models/product.model";
import { User } from "../src/models/user.model";
import { Order } from "../src/models/order.model";
import { Cart } from "../src/models/cart.model";
import { CartService, CartConflictError } from "../src/services/cart.service";
import {
  OrderService,
  OrderValidationError,
} from "../src/services/order.service";
import { AdminOrderService } from "../src/services/adminOrder.service";
import { AdminInventoryService } from "../src/services/adminInventory.service";
import { AdminProductService } from "../src/services/adminProduct.service";
import { ProductService } from "../src/services/product.service";
import historyRoutes from "../src/routes/adminInventoryHistory.routes";
import adminOrderRoutes from "../src/routes/adminOrder.routes";
import adminProductRoutes from "../src/routes/adminProduct.routes";
import legacyProductRoutes from "../src/routes/product.routes";

let stop: (() => Promise<void>) | undefined;
let http: Server | undefined;
let base = "";
let adminId: string;
let customerId: string;
let productId: string;
const previousSecret = process.env.JWT_SECRET;
const secret = "shopsphere-isolated-inventory-audit-tests";
const address = {
  fullName: "Fixture",
  phone: "09123456789",
  addressLine1: "Test Street",
  city: "Manila",
  province: "Metro Manila",
  postalCode: "1000",
};

before(
  async () => {
    stop = await startCartReplicaSet();
    await Promise.all([
      InventoryMovement.createIndexes(),
      Product.createIndexes(),
      Order.createIndexes(),
      Cart.createIndexes(),
      User.createIndexes(),
    ]);
    process.env.JWT_SECRET = secret;
    const app = express();
    app.use(express.json());
    app.use("/api/admin/inventory", historyRoutes);
    app.use("/api/admin", adminOrderRoutes);
    app.use("/api/admin/products", adminProductRoutes);
    app.use("/api/products", legacyProductRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => http!.once("listening", done));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  },
  { timeout: 60_000 },
);

beforeEach(async () => {
  assert.equal(mongoose.connection.name, "cart_concurrency_test");
  await Promise.all([
    InventoryMovement.deleteMany({}),
    Product.deleteMany({}),
    Order.deleteMany({}),
    Cart.deleteMany({}),
    User.deleteMany({}),
  ]);
  const [admin, customer, product] = await Promise.all([
    User.create({
      name: "Audit Admin",
      email: "admin@example.test",
      password: "fixture",
      isAdmin: true,
    }),
    User.create({
      name: "Audit Customer",
      email: "customer@example.test",
      password: "fixture",
      isAdmin: false,
    }),
    Product.create({
      name: "Audit Widget [A+]",
      sku: "AUDIT-A",
      slug: "audit-a",
      description: "Fixture",
      category: "Test",
      price: 25,
      stock: 10,
    }),
  ]);
  adminId = String(admin._id);
  customerId = String(customer._id);
  productId = String(product._id);
});
after(async () => {
  mock.restoreAll();
  if (http) await new Promise<void>((done) => http!.close(() => done()));
  if (stop) await stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function secondProduct() {
  return Product.create({
    name: "Second audit item",
    sku: "AUDIT-B",
    slug: "audit-b",
    description: "Fixture",
    category: "Test",
    price: 50,
    stock: 10,
  });
}
async function reviewedCart(
  items = [{ product: productId, quantity: 2 }],
  userId = customerId,
) {
  const cart = await CartService.getCartByUserId(userId);
  return CartService.saveOrUpdateCart(userId, {
    cartId: cart._id,
    version: cart.version,
    items,
  });
}
type Snapshot = Awaited<ReturnType<typeof reviewedCart>>;
const checkout = (cart: Snapshot) => ({
  cartId: cart._id,
  version: cart.version,
  shippingAddress: address,
  paymentMethod: "COD" as const,
});
async function place(
  items = [{ product: productId, quantity: 2 }],
  userId = customerId,
) {
  return OrderService.createOrder(
    userId,
    checkout(await reviewedCart(items, userId)),
  );
}
async function request(
  path: string,
  userId: string | undefined = adminId,
  method = "GET",
  body?: unknown,
) {
  const bearer = userId
    ? jwt.sign({ id: userId, isAdmin: userId === adminId }, secret)
    : undefined;
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const history = (query = "") =>
  request(`/api/admin/inventory/movements${query}`);
async function rows() {
  return InventoryMovement.find().sort({ createdAt: 1, _id: 1 }).lean();
}
function assertAccounting(movement: {
  adjustment: number;
  previousStock: number;
  newStock: number;
}) {
  assert.equal(movement.previousStock + movement.adjustment, movement.newStock);
  assert.ok(movement.newStock >= 0);
}
function movementFailureOn(secondCall = 1) {
  let calls = 0;
  const original = InventoryMovement.create.bind(InventoryMovement);
  const stub = mock.method(
    InventoryMovement,
    "create",
    (...args: Parameters<typeof InventoryMovement.create>) => {
      if (++calls >= secondCall)
        throw new Error("Injected movement persistence failure");
      return original(...args);
    },
  );
  return { restore: () => stub.mock.restore(), calls: () => calls };
}

test("multi-product checkout and eligible admin cancellation record matching per-product movements exactly once", async () => {
  const second = await secondProduct();
  const created = await place([
    { product: productId, quantity: 2 },
    { product: String(second._id), quantity: 3 },
  ]);
  const orderId = String((created as { _id?: unknown })._id);
  const sales = await rows();
  assert.equal(sales.length, 2);
  for (const movement of sales) {
    assert.equal(movement.type, "sale");
    assert.equal(String(movement.order), orderId);
    assert.equal(movement.actorType, "customer");
    assert.equal(String(movement.actor), customerId);
    assert.equal(movement.admin, undefined);
    assert.equal(movement.previousStock, 10);
    assertAccounting(movement);
  }
  assert.deepEqual(
    sales.map((row) => row.adjustment).sort((a, b) => a - b),
    [-3, -2],
  );
  const response = await request(
    `/api/admin/orders/${orderId}/status`,
    adminId,
    "PATCH",
    { status: "cancelled" },
  );
  assert.equal(response.status, 200);
  const restored = await InventoryMovement.find({
    type: "cancellation",
  }).lean();
  assert.equal(restored.length, 2);
  for (const movement of restored) {
    const sale = sales.find(
      (row) => String(row.product) === String(movement.product),
    )!;
    assert.equal(movement.adjustment, -sale.adjustment);
    assert.equal(movement.previousStock, sale.newStock);
    assert.equal(movement.newStock, 10);
    assert.equal(String(movement.actor), adminId);
    assert.equal(String(movement.admin), adminId);
    assert.equal(movement.actorType, "admin");
    assertAccounting(movement);
  }
  assert.equal(
    (
      await request(`/api/admin/orders/${orderId}/status`, adminId, "PATCH", {
        status: "cancelled",
      })
    ).status,
    409,
  );
  assert.equal(await InventoryMovement.countDocuments(), 4);
  assert.equal((await Product.findById(productId))!.stock, 10);
});

test(
  "overlapping last-stock purchases commit only one correct sale movement",
  { timeout: 15_000 },
  async () => {
    await Product.updateOne({ _id: productId }, { $set: { stock: 1 } });
    const other = await User.create({
      name: "Other Customer",
      email: "other@example.test",
      password: "fixture",
      isAdmin: false,
    });
    const userIds = [customerId, String(other._id)];
    const carts = await Promise.all(
      userIds.map((id) =>
        reviewedCart([{ product: productId, quantity: 1 }], id),
      ),
    );
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    let arrivals = 0;
    const original = Cart.findOne.bind(Cart);
    const stub = mock.method(
      Cart,
      "findOne",
      (...args: Parameters<typeof Cart.findOne>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const result = await exec();
          if (++arrivals <= 2) {
            if (arrivals === 2) release();
            await barrier;
          }
          return result;
        };
        return query;
      },
    );
    let results: PromiseSettledResult<Awaited<ReturnType<typeof place>>>[];
    try {
      results = await Promise.allSettled(
        userIds.map((id, index) =>
          OrderService.createOrder(id, checkout(carts[index]!)),
        ),
      );
      assert.ok(arrivals >= 2);
    } finally {
      release();
      stub.mock.restore();
    }
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(await Order.countDocuments(), 1);
    const movements = await rows();
    assert.equal(movements.length, 1);
    assert.equal(movements[0]!.adjustment, -1);
    assert.equal(movements[0]!.previousStock, 1);
    assert.equal(movements[0]!.newStock, 0);
    assert.equal((await Product.findById(productId))!.stock, 0);
  },
);

test(
  "overlapping cancellation attempts restore stock and write their movement once",
  { timeout: 15_000 },
  async () => {
    const created = await place();
    const id = String((created as { _id?: unknown })._id);
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    let arrivals = 0;
    const original = Order.findById.bind(Order);
    const stub = mock.method(
      Order,
      "findById",
      (...args: Parameters<typeof Order.findById>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const result = await exec();
          if (++arrivals <= 2) {
            if (arrivals === 2) release();
            await barrier;
          }
          return result;
        };
        return query;
      },
    );
    try {
      const results = await Promise.all(
        [1, 2].map(() =>
          AdminOrderService.updateOrderStatus(id, "cancelled", adminId),
        ),
      );
      assert.equal(
        results.filter((result) => result.result === "success").length,
        1,
      );
      assert.ok(arrivals >= 2);
    } finally {
      release();
      stub.mock.restore();
    }
    assert.equal(
      await InventoryMovement.countDocuments({ type: "cancellation" }),
      1,
    );
    assert.equal(await InventoryMovement.countDocuments(), 2);
    assert.equal((await Product.findById(productId))!.stock, 10);
  },
);

test(
  "overlapping checkout and manual adjustment report one authoritative stock chain",
  { timeout: 15_000 },
  async () => {
    const cart = await reviewedCart();
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    let arrivals = 0;
    const original = Product.findById.bind(Product);
    const stub = mock.method(
      Product,
      "findById",
      (...args: Parameters<typeof Product.findById>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const result = await exec();
          if (++arrivals <= 2) {
            if (arrivals === 2) release();
            await barrier;
          }
          return result;
        };
        return query;
      },
    );
    try {
      await Promise.all([
        OrderService.createOrder(customerId, checkout(cart)),
        AdminInventoryService.adjustStock(
          productId,
          adminId,
          3,
          "Concurrent restock",
        ),
      ]);
      assert.ok(arrivals >= 2);
    } finally {
      release();
      stub.mock.restore();
    }
    const movements = await rows();
    assert.equal(movements.length, 2);
    assert.equal(
      movements.reduce((sum, row) => sum + row.adjustment, 0),
      1,
    );
    const first = movements.find((row) => row.previousStock === 10)!;
    const next = movements.find(
      (row) => String(row._id) !== String(first._id),
    )!;
    assert.equal(next.previousStock, first.newStock);
    assert.equal(next.newStock, 11);
    assert.equal((await Product.findById(productId))!.stock, 11);
    movements.forEach(assertAccounting);
  },
);

test("insufficient stock after an earlier deduction rolls back stock and pending audit rows", async () => {
  const second = await secondProduct();
  const cart = await reviewedCart([
    { product: productId, quantity: 2 },
    { product: String(second._id), quantity: 2 },
  ]);
  await Product.updateOne({ _id: second._id }, { $set: { stock: 0 } });
  await assert.rejects(
    OrderService.createOrder(customerId, checkout(cart)),
    OrderValidationError,
  );
  assert.equal(await InventoryMovement.countDocuments(), 0);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(productId))!.stock, 10);
  assert.equal(
    (await CartService.getCartByUserId(customerId)).version,
    cart.version,
  );
});

test("movement failure after an earlier sale row rolls back the entire checkout", async () => {
  const second = await secondProduct();
  const cart = await reviewedCart([
    { product: productId, quantity: 2 },
    { product: String(second._id), quantity: 3 },
  ]);
  const failure = movementFailureOn(2);
  try {
    await assert.rejects(
      OrderService.createOrder(customerId, checkout(cart)),
      /Injected movement/,
    );
    assert.equal(failure.calls(), 2);
  } finally {
    failure.restore();
  }
  assert.equal(await InventoryMovement.countDocuments(), 0);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(productId))!.stock, 10);
  assert.equal((await Product.findById(second._id))!.stock, 10);
  assert.deepEqual(await CartService.getCartByUserId(customerId), cart);
});

test("order persistence and final cart-clear failures roll back sale movements too", async () => {
  for (const stage of ["order", "cart"]) {
    const cart = await reviewedCart();
    const stub =
      stage === "order"
        ? mock.method(Order, "create", async () => {
            throw new Error("Injected order failure");
          })
        : mock.method(Cart, "updateOne", async () => ({ modifiedCount: 0 }));
    try {
      await assert.rejects(
        OrderService.createOrder(customerId, checkout(cart)),
      );
    } finally {
      stub.mock.restore();
    }
    assert.equal(await InventoryMovement.countDocuments(), 0, stage);
    assert.equal(await Order.countDocuments(), 0, stage);
    assert.equal((await Product.findById(productId))!.stock, 10, stage);
  }
});

test("movement failure after an earlier restoration rolls back cancellation, stock and audit", async () => {
  const second = await secondProduct();
  const created = await place([
    { product: productId, quantity: 2 },
    { product: String(second._id), quantity: 3 },
  ]);
  const id = String((created as { _id?: unknown })._id);
  const failure = movementFailureOn(2);
  try {
    await assert.rejects(
      AdminOrderService.updateOrderStatus(id, "cancelled", adminId),
      /Injected movement/,
    );
  } finally {
    failure.restore();
  }
  assert.equal(
    await InventoryMovement.countDocuments({ type: "cancellation" }),
    0,
  );
  assert.equal(await InventoryMovement.countDocuments({ type: "sale" }), 2);
  assert.equal((await Product.findById(productId))!.stock, 8);
  assert.equal((await Product.findById(second._id))!.stock, 7);
  assert.equal((await Order.findById(id))!.orderStatus, "pending");
});

test("missing product makes cancellation fail without partial restoration or movements", async () => {
  const second = await secondProduct();
  const created = await place([
    { product: productId, quantity: 2 },
    { product: String(second._id), quantity: 3 },
  ]);
  const id = String((created as { _id?: unknown })._id);
  await Product.deleteOne({ _id: second._id });
  assert.equal(
    (await AdminOrderService.updateOrderStatus(id, "cancelled", adminId))
      .result,
    "inventory_error",
  );
  assert.equal(
    await InventoryMovement.countDocuments({ type: "cancellation" }),
    0,
  );
  assert.equal((await Product.findById(productId))!.stock, 8);
  assert.equal((await Order.findById(id))!.orderStatus, "pending");
});

test("legacy repeated product lines restore their sum once with one movement", async () => {
  await Product.updateOne({ _id: productId }, { $set: { stock: 7 } });
  const legacy = await Order.create({
    user: customerId,
    items: [1, 2].map((quantity) => ({
      product: productId,
      name: "Legacy widget",
      sku: "AUDIT-A",
      price: 25,
      quantity,
    })),
    shippingAddress: address,
    paymentMethod: "COD",
    paymentStatus: "unpaid",
    orderStatus: "pending",
    subtotal: 75,
    shippingFee: 0,
    total: 75,
  });
  assert.equal(
    (
      await AdminOrderService.updateOrderStatus(
        String(legacy._id),
        "cancelled",
        adminId,
      )
    ).result,
    "success",
  );
  const movements = await rows();
  assert.equal(movements.length, 1);
  assert.equal(movements[0]!.type, "cancellation");
  assert.deepEqual(
    [
      movements[0]!.previousStock,
      movements[0]!.adjustment,
      movements[0]!.newStock,
    ],
    [7, 3, 10],
  );
  assert.equal((await Product.findById(productId))!.stock, 10);
});

test("stale checkout/cart replay and COD collection add no movements", async () => {
  const cart = await reviewedCart();
  const created = await OrderService.createOrder(customerId, checkout(cart));
  const id = String((created as { _id?: unknown })._id);
  await assert.rejects(
    OrderService.createOrder(customerId, checkout(cart)),
    CartConflictError,
  );
  await assert.rejects(
    CartService.saveOrUpdateCart(customerId, {
      cartId: cart._id,
      version: cart.version,
      items: [{ product: productId, quantity: 2 }],
    }),
    CartConflictError,
  );
  for (const status of ["confirmed", "shipped", "delivered"] as const)
    assert.equal(
      (await AdminOrderService.updateOrderStatus(id, status, adminId)).result,
      "success",
    );
  const before = await rows();
  assert.equal(
    (await AdminOrderService.collectCodPayment(id, adminId)).result,
    "success",
  );
  assert.deepEqual(await rows(), before);
  assert.equal((await Product.findById(productId))!.stock, 8);
  assert.equal(
    (await AdminOrderService.updateOrderStatus(id, "cancelled", adminId))
      .result,
    "payment_conflict",
  );
  assert.deepEqual(await rows(), before);
});

test("manual adjustments, safe before/after values, and rollback remain functional", async () => {
  assert.equal(
    (
      await AdminInventoryService.adjustStock(
        productId,
        adminId,
        3,
        "Fixture restock",
      )
    ).result,
    "success",
  );
  assert.equal(
    (
      await AdminInventoryService.adjustStock(
        productId,
        adminId,
        -4,
        "Damaged units",
      )
    ).result,
    "success",
  );
  assert.equal(
    (
      await AdminInventoryService.adjustStock(
        productId,
        adminId,
        -99,
        "Too many",
      )
    ).result,
    "insufficient_stock",
  );
  const movements = await rows();
  assert.equal(movements.length, 2);
  assert.deepEqual(
    movements.map((row) => [row.previousStock, row.adjustment, row.newStock]),
    [
      [10, 3, 13],
      [13, -4, 9],
    ],
  );
  for (const movement of movements) {
    assert.equal(movement.type, "manual");
    assert.equal(movement.actorType, "admin");
    assert.equal(String(movement.actor), adminId);
    assertAccounting(movement);
  }
  const failure = movementFailureOn();
  try {
    await assert.rejects(
      AdminInventoryService.adjustStock(
        productId,
        adminId,
        1,
        "Must roll back",
      ),
      /Injected movement/,
    );
  } finally {
    failure.restore();
  }
  assert.equal((await Product.findById(productId))!.stock, 9);
  assert.deepEqual(await rows(), movements);
});

test("legacy manual rows remain readable with safe actor fallback", async () => {
  await InventoryMovement.collection.insertOne({
    product: new mongoose.Types.ObjectId(productId),
    admin: new mongoose.Types.ObjectId(adminId),
    adjustment: 2,
    previousStock: 8,
    newStock: 10,
    reason: "Legacy row",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const response = await history("?type=manual");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.movements[0].type, "manual");
  assert.equal(body.movements[0].actorType, "admin");
  assert.equal(body.movements[0].actor.name, "Audit Admin");
  assert.equal(body.movements[0].reason, "Legacy row");
  assert.ok(!JSON.stringify(body).includes("password"));
});

test("history preserves pagination/search/product filters and adds source/order filters", async () => {
  const created = await place();
  const id = String((created as { _id?: unknown })._id);
  await AdminInventoryService.adjustStock(productId, adminId, 3, "Restock");
  await AdminOrderService.updateOrderStatus(id, "cancelled", adminId);
  const first = await (await history("?limit=1&page=1")).json();
  const second = await (await history("?limit=1&page=2")).json();
  assert.deepEqual(first.pagination, {
    page: 1,
    limit: 1,
    total: 3,
    totalPages: 3,
  });
  assert.notEqual(first.movements[0]._id, second.movements[0]._id);
  for (const [type, count] of [
    ["sale", 1],
    ["manual", 1],
    ["cancellation", 1],
    ["added", 2],
    ["removed", 1],
  ] as const) {
    const body = await (await history(`?type=${type}`)).json();
    assert.equal(body.pagination.total, count, type);
  }
  assert.equal(
    (await (await history(`?orderId=${id}`)).json()).pagination.total,
    2,
  );
  assert.equal(
    (
      await (
        await history(
          `?productId=${productId}&search=${encodeURIComponent("Widget [A+]")}`,
        )
      ).json()
    ).pagination.total,
    3,
  );
  assert.equal(
    (await (await history("?search=audit-a")).json()).pagination.total,
    3,
  );
  assert.equal(
    (await (await history(`?search=${encodeURIComponent(".*")}`)).json())
      .pagination.total,
    0,
  );
  assert.equal(
    (
      await (
        await request("/api/admin/products/inventory/movements?type=sale")
      ).json()
    ).pagination.total,
    1,
  );
  for (const query of [
    "?type=invalid",
    "?productId=bad",
    "?orderId=bad",
    "?page=0",
    "?limit=101",
    "?type=sale&type=manual",
  ])
    assert.equal((await history(query)).status, 400, query);
});

test("history is admin-only and exposes no customer movement mutation endpoint", async () => {
  await place();
  assert.equal(
    (await request("/api/admin/inventory/movements", "")).status,
    401,
  );
  assert.equal(
    (await request("/api/admin/inventory/movements", customerId)).status,
    403,
  );
  assert.equal(
    (
      await request("/api/admin/inventory/movements", customerId, "POST", {
        adjustment: 100,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/admin/inventory/movements", adminId, "POST", {
        adjustment: 100,
      })
    ).status,
    404,
  );
  assert.equal(await InventoryMovement.countDocuments(), 1);
});

test("initial stock and legacy absolute stock edits are audited without changing API shapes", async () => {
  const input = (sku: string, stock: number) => ({
    name: "Created fixture",
    sku,
    slug: sku.toLowerCase(),
    description: "Fixture",
    category: "Test",
    price: 10,
    stock,
  });
  const adminResponse = await request(
    "/api/admin/products",
    adminId,
    "POST",
    input("CREATE-A", 4),
  );
  assert.equal(adminResponse.status, 201);
  const adminProduct = (await adminResponse.json()).product;
  const legacyResponse = await request(
    "/api/products",
    adminId,
    "POST",
    input("CREATE-B", 5),
  );
  assert.equal(legacyResponse.status, 201);
  const legacyProduct = await legacyResponse.json();
  assert.equal(legacyProduct.stock, 5);
  assert.equal(
    (
      await request(`/api/products/${legacyProduct._id}`, adminId, "PATCH", {
        stock: 7,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/products/${legacyProduct._id}`, adminId, "PATCH", {
        stock: 7,
      })
    ).status,
    200,
  );
  assert.equal(await InventoryMovement.countDocuments(), 3);
  const initial = await InventoryMovement.findOne({
    product: adminProduct._id,
  });
  assert.equal(initial!.previousStock, 0);
  assert.equal(initial!.newStock, 4);
  const zero = await AdminProductService.createProduct(
    input("CREATE-ZERO", 0),
    adminId,
  );
  assert.equal(
    await InventoryMovement.countDocuments({ product: zero!._id }),
    0,
  );
  const failure = movementFailureOn();
  try {
    await assert.rejects(
      AdminProductService.createProduct(input("CREATE-FAIL", 1), adminId),
      /Injected movement/,
    );
    await assert.rejects(
      ProductService.updateProduct(
        legacyProduct._id,
        { stock: 9, name: "Must roll back" },
        adminId,
      ),
      /Injected movement/,
    );
  } finally {
    failure.restore();
  }
  assert.equal(await Product.countDocuments({ sku: "CREATE-FAIL" }), 0);
  assert.equal((await Product.findById(legacyProduct._id))!.stock, 7);
  assert.equal(
    (await Product.findById(legacyProduct._id))!.name,
    "Created fixture",
  );
  assert.equal(await InventoryMovement.countDocuments(), 3);
});
