import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";
import { Cart } from "../src/models/cart.model";
import { Order } from "../src/models/order.model";
import { CheckoutAttempt } from "../src/models/checkoutAttempt.model";
import { Product } from "../src/models/product.model";
import { User } from "../src/models/user.model";
import { InventoryMovement } from "../src/models/inventoryMovement.model";
import { CartService, CartConflictError } from "../src/services/cart.service";
import { OrderService } from "../src/services/order.service";
import { CheckoutKeyConflictError } from "../src/services/checkoutAttempt.service";
import { OrderController } from "../src/controllers/order.controller";
import { protect } from "../src/middleware/auth.middleware";
import routes from "../src/routes/order.routes";

let stop: (() => Promise<void>) | undefined,
  http: Server | undefined,
  base = "",
  userId = "",
  productId = "";
const secret = "isolated-keyed-checkout-fixture";
const previousSecret = process.env.JWT_SECRET;
const key = "fixture-key-0000000001";
const address = {
  fullName: "Fixture",
  phone: "09123456789",
  addressLine1: "Fixture",
  city: "Manila",
  province: "Manila",
  postalCode: "1000",
};
before(
  async () => {
    stop = await startCartReplicaSet();
    await Promise.all([
      Cart.createIndexes(),
      Order.createIndexes(),
      CheckoutAttempt.createIndexes(),
      Product.createIndexes(),
      User.createIndexes(),
      InventoryMovement.createIndexes(),
    ]);
    process.env.JWT_SECRET = secret;
    const app = express();
    app.use(express.json());
    app.use("/api/orders", routes);
    app.post("/lost-response", protect, (req, res) => {
      res.json = () => {
        res.destroy();
        return res;
      };
      return OrderController.createOrder(req, res);
    });
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http!.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  },
  { timeout: 60000 },
);
beforeEach(async () => {
  assert.equal(mongoose.connection.name, "cart_concurrency_test");
  await Promise.all([
    CheckoutAttempt.deleteMany({}),
    Cart.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    User.deleteMany({}),
    InventoryMovement.deleteMany({}),
  ]);
  const user = await User.create({
    name: "Fixture",
    email: "owner@example.test",
    password: "fixture",
  });
  userId = String(user._id);
  const product = await Product.create({
    name: "Fixture",
    sku: "KEYED",
    slug: "keyed",
    description: "Fixture",
    category: "Home",
    price: 25,
    stock: 10,
  });
  productId = String(product._id);
});
after(async () => {
  mock.restoreAll();
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  if (stop) await stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
async function payload(owner = userId) {
  const cart = await CartService.getCartByUserId(owner);
  const filled = await CartService.saveOrUpdateCart(owner, {
    cartId: cart._id,
    version: cart.version,
    items: [{ product: productId, quantity: 2 }],
  });
  return {
    cartId: filled._id!,
    version: filled.version,
    shippingAddress: address,
    paymentMethod: "COD" as const,
    idempotencyKey: key,
  };
}
async function request(path: string, body?: unknown, owner = userId) {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Bearer " + jwt.sign({ id: owner, isAdmin: false }, secret),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const idOf = (order: unknown) => String((order as { _id: unknown })._id);
async function assertOnce(input: Awaited<ReturnType<typeof payload>>) {
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await CheckoutAttempt.countDocuments(), 1);
  assert.equal((await Product.findById(productId))!.stock, 8);
  assert.equal(await InventoryMovement.countDocuments({ type: "sale" }), 1);
  const cart = await Cart.findById(input.cartId);
  assert.equal(cart!.items.length, 0);
  assert.equal(cart!.__v, input.version + 1);
}
test("normal keyed COD checkout and identical committed retries return one original order without repeating inventory/cart completion", async () => {
  const input = await payload();
  const first = await request("/api/orders", input);
  assert.equal(first.status, 201);
  const original = await first.json();
  await Product.updateOne({ _id: productId }, { $set: { price: 99 } });
  const replay = await request("/api/orders", input);
  assert.equal(replay.status, 201);
  const recovered = await replay.json();
  assert.equal(recovered._id, original._id);
  assert.equal(recovered.total, 50);
  assert.equal(recovered.paymentStatus, "unpaid");
  assert.equal(recovered.paidAt, undefined);
  const lookup = await request("/api/orders/checkout-attempts/" + key);
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json())._id, original._id);
  await assertOnce(input);
});
test(
  "simultaneous same-key requests with overlapping snapshots create exactly one order",
  { timeout: 20000 },
  async () => {
    const input = await payload();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const original = CheckoutAttempt.findOne.bind(CheckoutAttempt);
    const stub = mock.method(
      CheckoutAttempt,
      "findOne",
      (...args: Parameters<typeof CheckoutAttempt.findOne>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const result = await exec();
          if (query.getOptions().session && ++arrivals <= 2) {
            if (arrivals === 2) release();
            await barrier;
          }
          return result;
        };
        return query;
      },
    );
    try {
      const results = await Promise.all([
        OrderService.createOrder(userId, input),
        OrderService.createOrder(userId, input),
      ]);
      assert.equal(idOf(results[0]), idOf(results[1]));
      assert.ok(arrivals >= 2);
    } finally {
      release();
      stub.mock.restore();
    }
    await assertOnce(input);
  },
);
test("same key with changed address, cart revision or cart identity conflicts, but canonical equivalent address retries match", async () => {
  const input = await payload();
  const first = await OrderService.createOrder(userId, input);
  for (const changed of [
    { ...input, shippingAddress: { ...address, city: "Other" } },
    { ...input, version: input.version + 1 },
    { ...input, cartId: String(new mongoose.Types.ObjectId()) },
  ])
    await assert.rejects(
      OrderService.createOrder(userId, changed),
      CheckoutKeyConflictError,
    );
  const response = await request("/api/orders", {
    ...input,
    shippingAddress: { ...address, city: "Other" },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CHECKOUT_KEY_CONFLICT");
  assert.equal(
    idOf(
      await OrderService.createOrder(userId, {
        ...input,
        shippingAddress: { ...address, city: " Manila ", addressLine2: "" },
      }),
    ),
    idOf(first),
  );
  await assertOnce(input);
});
test("the same key belongs independently to each authenticated customer and lookup cannot disclose another order", async () => {
  const input = await payload();
  const first = await OrderService.createOrder(userId, input);
  const other = await User.create({
    name: "Other",
    email: "other@example.test",
    password: "fixture",
  });
  const otherId = String(other._id);
  assert.equal(
    (await request("/api/orders/checkout-attempts/" + key, undefined, otherId))
      .status,
    404,
  );
  const second = await OrderService.createOrder(
    otherId,
    await payload(otherId),
  );
  assert.notEqual(idOf(first), idOf(second));
  assert.equal(
    (
      await (
        await request(
          "/api/orders/checkout-attempts/" + key,
          undefined,
          otherId,
        )
      ).json()
    )._id,
    idOf(second),
  );
  assert.equal(await CheckoutAttempt.countDocuments(), 2);
  assert.equal((await Product.findById(productId))!.stock, 6);
});
test("a response lost after HTTP controller commit recovers the original order by POST replay and GET check", async () => {
  const input = await payload();
  await assert.rejects(request("/lost-response", input));
  const existing = await Order.findOne({ user: userId });
  assert.ok(existing);
  const replay = await request("/api/orders", input);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json())._id, String(existing._id));
  await assertOnce(input);
});
test("transient transaction failure retries atomically and leaves one sale and attempt", async () => {
  const input = await payload();
  const original = InventoryMovement.create.bind(InventoryMovement);
  let calls = 0;
  const stub = mock.method(
    InventoryMovement,
    "create",
    (...args: Parameters<typeof InventoryMovement.create>) => {
      if (++calls === 1) {
        const error = new mongoose.mongo.MongoServerError({
          message: "Fixture transient conflict",
          code: 112,
        });
        error.addErrorLabel("TransientTransactionError");
        throw error;
      }
      return original(...args);
    },
  );
  try {
    await OrderService.createOrder(userId, input);
    assert.equal(calls, 2);
  } finally {
    stub.mock.restore();
  }
  await assertOnce(input);
});
test("failed movement persistence is not cached and an explicit same-key retry can succeed", async () => {
  const input = await payload();
  const stub = mock.method(InventoryMovement, "create", () => {
    throw new Error("Fixture persistence failure");
  });
  try {
    const response = await request("/api/orders", input);
    assert.equal(response.status, 500);
  } finally {
    stub.mock.restore();
  }
  assert.equal(await CheckoutAttempt.countDocuments(), 0);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(productId))!.stock, 10);
  await OrderService.createOrder(userId, input);
  await assertOnce(input);
});
test("insufficient stock, inactive product, stale cart and invalid key retain existing failures without durable success records", async () => {
  const input = await payload();
  await Product.updateOne({ _id: productId }, { $set: { stock: 1 } });
  assert.equal((await request("/api/orders", input)).status, 400);
  await Product.updateOne(
    { _id: productId },
    { $set: { stock: 10, isActive: false } },
  );
  assert.equal((await request("/api/orders", input)).status, 400);
  await Product.updateOne({ _id: productId }, { $set: { isActive: true } });
  for (const idempotencyKey of [null, {}, [], "short", "x".repeat(129)])
    assert.equal(
      (await request("/api/orders", { ...input, idempotencyKey })).status,
      400,
    );
  await CartService.saveOrUpdateCart(userId, {
    cartId: input.cartId,
    version: input.version,
    items: [{ product: productId, quantity: 1 }],
  });
  await assert.rejects(
    OrderService.createOrder(userId, input),
    CartConflictError,
  );
  assert.equal(await CheckoutAttempt.countDocuments(), 0);
  assert.equal(await InventoryMovement.countDocuments(), 0);
});

test("uncertain commit error after durable commit resolves the original result without repeating stock changes", async () => {
  const input = await payload();
  const original = mongoose.startSession.bind(mongoose);
  const stub = mock.method(mongoose, "startSession", async () => {
    const session = await original();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = async (
      ...args: Parameters<typeof session.withTransaction>
    ) => {
      await transact(...args);
      const error = new mongoose.mongo.MongoServerError({
        message: "Fixture lost commit acknowledgement",
        code: 91,
      });
      error.addErrorLabel("UnknownTransactionCommitResult");
      throw error;
    };
    return session;
  });
  try {
    assert.ok(await OrderService.createOrder(userId, input));
  } finally {
    stub.mock.restore();
  }
  await assertOnce(input);
});

test("a still-uncertain transaction returns a controlled retryable response and can later retry", async () => {
  const input = await payload();
  const original = mongoose.startSession.bind(mongoose);
  const stub = mock.method(mongoose, "startSession", async () => {
    const session = await original();
    session.withTransaction = async () => {
      const error = new mongoose.mongo.MongoServerError({
        message: "Fixture unavailable commit status",
        code: 91,
      });
      error.addErrorLabel("UnknownTransactionCommitResult");
      throw error;
    };
    return session;
  });
  try {
    const response = await request("/api/orders", input);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal((await response.json()).code, "CHECKOUT_RETRYABLE");
  } finally {
    stub.mock.restore();
  }
  assert.equal(await CheckoutAttempt.countDocuments(), 0);
  await OrderService.createOrder(userId, input);
  await assertOnce(input);
});
