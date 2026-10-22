import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";
import { Cart } from "../src/models/cart.model";
import { Order } from "../src/models/order.model";
import { Product } from "../src/models/product.model";
import { User } from "../src/models/user.model";
import {
  CartService,
  CartConflictError,
  CartValidationError,
} from "../src/services/cart.service";
import {
  OrderService,
  OrderValidationError,
} from "../src/services/order.service";
import cartRoutes from "../src/routes/cart.routes";
import orderRoutes from "../src/routes/order.routes";

let stop: (() => Promise<void>) | undefined;
let http: Server | undefined;
let base = "";
const secret = "shopsphere-cart-checkout-isolated-tests";
const previousSecret = process.env.JWT_SECRET;
const address = {
  fullName: "Fixture Customer",
  phone: "09123456789",
  addressLine1: "Test address",
  city: "Test",
  province: "Test",
  postalCode: "1000",
};

before(
  async () => {
    stop = await startCartReplicaSet();
    // Explicitly build the unique user/cart index used by concurrent creation.
    await Promise.all([
      Cart.createIndexes(),
      Order.createIndexes(),
      Product.createIndexes(),
      User.createIndexes(),
    ]);
    process.env.JWT_SECRET = secret;
    const app = express();
    app.use(express.json());
    app.use("/api/cart", cartRoutes);
    app.use("/api/orders", orderRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => http!.once("listening", done));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  },
  { timeout: 60_000 },
);

beforeEach(async () => {
  assert.equal(mongoose.connection.name, "cart_concurrency_test");
  await Promise.all([
    Cart.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    User.deleteMany({}),
  ]);
});
after(async () => {
  mock.restoreAll();
  if (http) await new Promise<void>((done) => http!.close(() => done()));
  if (stop) await stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function customer(email = "customer@example.test") {
  return User.create({
    name: "Fixture customer",
    email,
    password: "not-a-real-password",
    isAdmin: false,
  });
}
async function product(sku = "ITEM-A", stock = 10, price = 25) {
  return Product.create({
    name: "Fixture product",
    slug: sku.toLowerCase(),
    sku,
    description: "Isolated fixture",
    category: "Test",
    price,
    stock,
    isActive: true,
  });
}
type Snapshot = Awaited<ReturnType<typeof CartService.getCartByUserId>>;
const revision = (cart: Snapshot) => ({
  cartId: cart._id,
  version: cart.version,
});
const checkout = (cart: Snapshot) => ({
  ...revision(cart),
  shippingAddress: address,
  paymentMethod: "COD" as const,
});
async function fill(
  userId: string,
  items: Array<{ product: string; quantity: number }>,
) {
  return CartService.saveOrUpdateCart(userId, {
    ...revision(await CartService.getCartByUserId(userId)),
    items,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Both queries have actually read MongoDB before either writer can proceed.
// Retries bypass the barrier so the transaction driver may safely retry.
function overlapCartReads() {
  const released = deferred();
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
          if (arrivals === 2) released.resolve();
          await released.promise;
        }
        return result;
      };
      return query;
    },
  );
  return { restore: () => stub.mock.restore(), arrivals: () => arrivals };
}

async function request(
  path: string,
  userId?: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(userId
        ? {
            Authorization: `Bearer ${jwt.sign({ id: userId, isAdmin: false }, secret)}`,
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test(
  "overlapping cart replacements/quantity changes have one winner, a 409 loser, and recover by refetch",
  { timeout: 15_000 },
  async () => {
    const user = await customer();
    const item = await product();
    const cart = await fill(String(user._id), [
      { product: String(item._id), quantity: 1 },
    ]);
    const gate = overlapCartReads();
    let responses: Response[];
    try {
      responses = await Promise.all(
        [2, 3].map((quantity) =>
          request("/api/cart", String(user._id), "PUT", {
            ...revision(cart),
            items: [{ product: String(item._id), quantity }],
          }),
        ),
      );
      assert.ok(gate.arrivals() >= 2);
    } finally {
      gate.restore();
    }
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const current = await CartService.getCartByUserId(String(user._id));
    assert.equal(current.version, cart.version + 1);
    assert.ok([2, 3].includes(current.items[0]!.quantity));
    const recovered = await CartService.saveOrUpdateCart(String(user._id), {
      ...revision(current),
      items: [{ product: String(item._id), quantity: 4 }],
    });
    assert.equal(recovered.version, cart.version + 2);
    assert.equal(recovered.items[0]!.quantity, 4);
  },
);

test(
  "overlapping first writes create one unique cart and reject stale no-cart snapshots",
  { timeout: 15_000 },
  async () => {
    const user = await customer();
    const item = await product();
    const empty = await CartService.getCartByUserId(String(user._id));
    const release = deferred();
    let arrivals = 0;
    const original = Cart.findOneAndUpdate.bind(Cart);
    const stub = mock.method(
      Cart,
      "findOneAndUpdate",
      (...args: Parameters<typeof Cart.findOneAndUpdate>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          if (++arrivals === 2) release.resolve();
          await release.promise;
          return exec();
        };
        return query;
      },
    );
    let results: PromiseSettledResult<Snapshot>[];
    try {
      results = await Promise.allSettled(
        [1, 2].map((quantity) =>
          CartService.saveOrUpdateCart(String(user._id), {
            ...revision(empty),
            items: [{ product: String(item._id), quantity }],
          }),
        ),
      );
      assert.equal(arrivals, 2);
    } finally {
      stub.mock.restore();
    }
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const failed = results.find((result) => result.status === "rejected");
    assert.ok(
      failed?.status === "rejected" &&
        failed.reason instanceof CartConflictError,
    );
    assert.equal(await Cart.countDocuments({ user: user._id }), 1);
    assert.equal(
      (await CartService.getCartByUserId(String(user._id))).version,
      1,
    );
  },
);

test(
  "overlapping checkouts of the same reviewed cart create exactly one order",
  { timeout: 15_000 },
  async () => {
    const user = await customer();
    const item = await product();
    const cart = await fill(String(user._id), [
      { product: String(item._id), quantity: 2 },
    ]);
    const gate = overlapCartReads();
    let responses: Response[];
    try {
      responses = await Promise.all(
        [1, 2].map(() =>
          request("/api/orders", String(user._id), "POST", checkout(cart)),
        ),
      );
      assert.ok(gate.arrivals() >= 2);
    } finally {
      gate.restore();
    }
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409],
    );
    assert.equal(await Order.countDocuments(), 1);
    assert.equal((await Product.findById(item._id))!.stock, 8);
    const cleared = await CartService.getCartByUserId(String(user._id));
    assert.equal(cleared._id, cart._id);
    assert.equal(cleared.version, cart.version + 1);
    assert.equal(cleared.items.length, 0);
    const order = await Order.findOne();
    assert.equal(order!.total, 50);
    assert.equal(order!.shippingFee, 0);
    assert.equal(order!.items.length, 1);
    assert.equal(order!.items[0]!.quantity, 2);
    assert.equal(order!.items[0]!.price, 25);
    assert.equal(String(order!.items[0]!.product), String(item._id));
    assert.equal(order!.paymentMethod, "COD");
    assert.equal(order!.paymentStatus, "unpaid");
    assert.equal(order!.orderStatus, "pending");
  },
);

test(
  "overlapping customers buying the final unit cannot oversell",
  { timeout: 15_000 },
  async () => {
    const [first, second] = await Promise.all([
      customer(),
      customer("second@example.test"),
    ]);
    const item = await product("LAST-UNIT", 1);
    const carts = await Promise.all(
      [first, second].map((user) =>
        fill(String(user._id), [{ product: String(item._id), quantity: 1 }]),
      ),
    );
    const gate = overlapCartReads();
    let responses: Response[];
    try {
      responses = await Promise.all(
        [first, second].map((user, index) =>
          request(
            "/api/orders",
            String(user._id),
            "POST",
            checkout(carts[index]!),
          ),
        ),
      );
      assert.ok(gate.arrivals() >= 2);
    } finally {
      gate.restore();
    }
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 400],
    );
    assert.equal(await Order.countDocuments(), 1);
    assert.equal((await Product.findById(item._id))!.stock, 0);
    const remaining = await Cart.find();
    assert.deepEqual(remaining.map((cart) => cart.items.length).sort(), [0, 1]);
  },
);

test(
  "an edit committed after checkout reads forces rollback rather than checking out unseen contents",
  { timeout: 15_000 },
  async () => {
    const user = await customer();
    const item = await product();
    const cart = await fill(String(user._id), [
      { product: String(item._id), quantity: 1 },
    ]);
    const read = deferred();
    const release = deferred();
    let paused = false;
    const original = Cart.findOne.bind(Cart);
    const stub = mock.method(
      Cart,
      "findOne",
      (...args: Parameters<typeof Cart.findOne>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const result = await exec();
          if (query.getOptions().session && !paused) {
            paused = true;
            read.resolve();
            await release.promise;
          }
          return result;
        };
        return query;
      },
    );
    const pending = OrderService.createOrder(String(user._id), checkout(cart));
    try {
      await read.promise;
      await CartService.saveOrUpdateCart(String(user._id), {
        ...revision(cart),
        items: [{ product: String(item._id), quantity: 3 }],
      });
      release.resolve();
      await assert.rejects(pending, CartConflictError);
    } finally {
      release.resolve();
      stub.mock.restore();
    }
    assert.equal(await Order.countDocuments(), 0);
    assert.equal((await Product.findById(item._id))!.stock, 10);
    assert.equal(
      (await CartService.getCartByUserId(String(user._id))).items[0]!.quantity,
      3,
    );
  },
);

test(
  "checkout committed before a waiting cart write cannot resurrect purchased items",
  { timeout: 15_000 },
  async () => {
    const user = await customer();
    const item = await product();
    const cart = await fill(String(user._id), [
      { product: String(item._id), quantity: 1 },
    ]);
    const reached = deferred();
    const release = deferred();
    const original = Cart.findOneAndUpdate.bind(Cart);
    const stub = mock.method(
      Cart,
      "findOneAndUpdate",
      (...args: Parameters<typeof Cart.findOneAndUpdate>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          reached.resolve();
          await release.promise;
          return exec();
        };
        return query;
      },
    );
    const pending = CartService.saveOrUpdateCart(String(user._id), {
      ...revision(cart),
      items: [{ product: String(item._id), quantity: 4 }],
    });
    try {
      await reached.promise;
      await OrderService.createOrder(String(user._id), checkout(cart));
      release.resolve();
      await assert.rejects(pending, CartConflictError);
    } finally {
      release.resolve();
      stub.mock.restore();
    }
    assert.equal(await Order.countDocuments(), 1);
    assert.equal(
      (await CartService.getCartByUserId(String(user._id))).items.length,
      0,
    );
  },
);

test("insufficient stock after an earlier deduction rolls back all order/cart changes", async () => {
  const user = await customer();
  const first = await product();
  const second = await product("ITEM-B");
  const cart = await fill(
    String(user._id),
    [first, second].map((item) => ({ product: String(item._id), quantity: 2 })),
  );
  await Product.updateOne({ _id: second._id }, { $set: { stock: 0 } });
  const beforeCheckout = await CartService.getCartByUserId(String(user._id));
  await assert.rejects(
    OrderService.createOrder(String(user._id), checkout(cart)),
    OrderValidationError,
  );
  assert.equal((await Product.findById(first._id))!.stock, 10);
  assert.equal(await Order.countDocuments(), 0);
  assert.deepEqual(
    await CartService.getCartByUserId(String(user._id)),
    beforeCheckout,
  );
  assert.equal(
    (await CartService.getCartByUserId(String(user._id))).version,
    cart.version,
  );
  assert.equal((await Cart.findById(cart._id))!.items.length, 2);
});

test("order creation failure rolls stock back and preserves the original cart", async () => {
  const user = await customer();
  const item = await product();
  const cart = await fill(String(user._id), [
    { product: String(item._id), quantity: 2 },
  ]);
  const stub = mock.method(Order, "create", async () => {
    throw new Error("Injected order persistence failure");
  });
  try {
    await assert.rejects(
      OrderService.createOrder(String(user._id), checkout(cart)),
      /Injected order persistence failure/,
    );
  } finally {
    stub.mock.restore();
  }
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(item._id))!.stock, 10);
  assert.deepEqual(await CartService.getCartByUserId(String(user._id)), cart);
});

test("failed final cart compare-and-swap rolls back the newly created order and stock", async () => {
  const user = await customer();
  const item = await product();
  const cart = await fill(String(user._id), [
    { product: String(item._id), quantity: 2 },
  ]);
  const stub = mock.method(Cart, "updateOne", async () => ({
    modifiedCount: 0,
  }));
  try {
    await assert.rejects(
      OrderService.createOrder(String(user._id), checkout(cart)),
      CartConflictError,
    );
  } finally {
    stub.mock.restore();
  }
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(item._id))!.stock, 10);
  assert.deepEqual(await CartService.getCartByUserId(String(user._id)), cart);
});

test("deleted and inactive products stay visible/removable, cannot increase, and block checkout", async () => {
  const user = await customer();
  const first = await product();
  const second = await product("INACTIVE");
  const cart = await fill(
    String(user._id),
    [first, second].map((item) => ({ product: String(item._id), quantity: 1 })),
  );
  await Product.deleteOne({ _id: first._id });
  await Product.updateOne({ _id: second._id }, { $set: { isActive: false } });
  const current = await CartService.getCartByUserId(String(user._id));
  assert.equal(current.items[0]!.product, null);
  assert.equal(current.items[0]!.productId, String(first._id));
  await assert.rejects(
    OrderService.createOrder(String(user._id), checkout(cart)),
    OrderValidationError,
  );
  await assert.rejects(
    CartService.saveOrUpdateCart(String(user._id), {
      ...revision(current),
      items: [{ product: String(first._id), quantity: 2 }],
    }),
    CartValidationError,
  );
  const removed = await CartService.saveOrUpdateCart(String(user._id), {
    ...revision(current),
    items: [{ product: String(second._id), quantity: 1 }],
  });
  assert.equal(removed.items.length, 1);
  const empty = await CartService.saveOrUpdateCart(String(user._id), {
    ...revision(removed),
    items: [],
  });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.version, cart.version + 2);
  assert.equal(await Order.countDocuments(), 0);
});

test("legacy zero/missing versions advance atomically without migration", async () => {
  const item = await product();
  for (const legacyVersion of [0, undefined]) {
    const user = await customer(`legacy-${String(legacyVersion)}@example.test`);
    const cartId = new mongoose.Types.ObjectId();
    await Cart.collection.insertOne({
      _id: cartId,
      user: user._id,
      items: [{ product: item._id, quantity: 1 }],
      ...(legacyVersion === undefined ? {} : { __v: legacyVersion }),
    });
    const cart = await CartService.getCartByUserId(String(user._id));
    assert.equal(cart.version, 0);
    const updated = await CartService.saveOrUpdateCart(String(user._id), {
      ...revision(cart),
      items: [{ product: String(item._id), quantity: 2 }],
    });
    assert.equal(updated.version, 1);
    await assert.rejects(
      CartService.saveOrUpdateCart(String(user._id), {
        ...revision(cart),
        items: [],
      }),
      CartConflictError,
    );
  }
});

test("cart revision/input validation and user ownership are enforced by real HTTP routes", async () => {
  const [first, second] = await Promise.all([
    customer(),
    customer("other@example.test"),
  ]);
  const item = await product();
  const cart = await fill(String(first._id), [
    { product: String(item._id), quantity: 1 },
  ]);
  for (const body of [
    {},
    { ...revision(cart), items: null },
    { ...revision(cart), version: -1, items: [] },
    { ...revision(cart), items: [{ product: { $ne: "" }, quantity: 1 }] },
    {
      ...revision(cart),
      items: [{ product: String(item._id), quantity: 1.5 }],
    },
    { ...revision(cart), items: [{ product: String(item._id), quantity: 0 }] },
    { ...revision(cart), items: [{ product: String(item._id), quantity: 20 }] },
    {
      ...revision(cart),
      items: [1, 2].map(() => ({ product: String(item._id), quantity: 1 })),
    },
  ]) {
    assert.equal(
      (await request("/api/cart", String(first._id), "PUT", body)).status,
      400,
    );
  }
  assert.equal((await request("/api/cart")).status, 401);
  assert.equal(
    (
      await request("/api/cart", undefined, "PUT", {
        ...revision(cart),
        items: [],
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/cart", String(second._id), "PUT", {
        ...revision(cart),
        items: [],
      })
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/orders", String(second._id), "POST", checkout(cart)))
      .status,
    409,
  );
  const own = await CartService.getCartByUserId(String(second._id));
  assert.equal(own.items.length, 0);
  const orderResponse = await request(
    "/api/orders",
    String(first._id),
    "POST",
    checkout(cart),
  );
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.equal(
    (await request(`/api/orders/${order._id}`, String(second._id))).status,
    404,
  );
  assert.equal(
    (await request(`/api/orders/${order._id}`, String(first._id))).status,
    200,
  );
});
