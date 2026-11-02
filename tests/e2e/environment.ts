import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { startCartReplicaSet } from "../helpers/cartReplicaSet";
import { User } from "../../src/models/user.model";
import { Product } from "../../src/models/product.model";
import { Order } from "../../src/models/order.model";
import { Cart } from "../../src/models/cart.model";
import { InventoryMovement } from "../../src/models/inventoryMovement.model";
import { CheckoutAttempt } from "../../src/models/checkoutAttempt.model";

const root = resolve(__dirname, "../../..");
const fixturePassword = "E2eFixture123";
const fixtureSecret = "shopsphere-disposable-e2e-only-secret";
const models = [User, Product, Order, Cart, InventoryMovement, CheckoutAttempt];
const ids = {
  admin: "100000000000000000000001",
  a: "100000000000000000000002",
  b: "100000000000000000000003",
  alpha: "200000000000000000000001",
  bravo: "200000000000000000000002",
  inactive: "200000000000000000000099",
};
const oid = (id: string) => new mongoose.Types.ObjectId(id);
function assertIsolated() {
  assert.equal(mongoose.connection.name, "shopsphere_e2e");
  assert.ok(["127.0.0.1", "localhost"].includes(mongoose.connection.host));
  assert.equal(process.env.NODE_ENV, "test");
}
const accounts = {
  admin: { email: "admin@e2e.example.test", password: fixturePassword },
  a: { email: "a@e2e.example.test", password: fixturePassword },
  b: { email: "b@e2e.example.test", password: fixturePassword },
};
const tokens = Object.fromEntries(
  Object.entries(ids)
    .filter(([key]) => ["admin", "a", "b"].includes(key))
    .map(([key, id]) => [
      key,
      jwt.sign({ id, isAdmin: key === "admin" }, fixtureSecret, {
        expiresIn: "1h",
      }),
    ]),
);
let stop: (() => Promise<void>) | undefined;
const children: ChildProcess[] = [];
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let closing = false;
let ready = false;
async function close(closeHttp = true) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  if (closeHttp && server)
    await new Promise<void>((done) => server!.close(() => done()));
  if (stop) await stop();
}
async function main() {
  // No URI is accepted from the environment. This helper owns a fresh mongod,
  // random loopback port and temporary dbpath; the hard-coded E2E DB is disposable.
  for (const port of [4400, 4173, 4174]) {
    const probe = createServer();
    await new Promise<void>((done, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => done()));
    });
  }
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = fixtureSecret;
  stop = await startCartReplicaSet("shopsphere_e2e");
  assertIsolated();
  process.env.MONGO_URI = `mongodb://127.0.0.1:${mongoose.connection.port}/shopsphere_e2e?directConnection=true`;
  await Promise.all(models.map((model) => model.createIndexes()));
  const password = await bcrypt.hash(fixturePassword, 10);
  function loadApp() {
    // Fresh rate-limiter buckets per independent scenario, without changing the
    // application limits or bypassing auth routes/middleware under test.
    for (const file of ["../../src/routes/auth.routes", "../../src/app"])
      delete require.cache[require.resolve(file)];
    return (require("../../src/app") as { default: express.Application })
      .default;
  }
  let application = loadApp();
  const harness = express();
  harness.use("/__e2e", express.json());
  harness.get("/__e2e/health", (_req, res) => {
    assertIsolated();
    res.status(ready ? 200 : 503).json({ ready, database: "shopsphere_e2e" });
  });
  harness.post("/__e2e/stop", async (_req, res) => {
    await close(false);
    res.json({ stopped: true });
    server!.close(() => process.exit(0));
  });
  harness.post("/__e2e/password-reset-token", async (req, res, next) => {
    try {
      assertIsolated();
      const account = Object.entries(accounts).find(
        ([key, value]) => key !== "admin" && value.email === req.body.email,
      );
      if (!account) {
        res.status(400).json({ message: "A test customer email is required." });
        return;
      }
      const token = randomBytes(32).toString("hex");
      const result = await User.updateOne(
        { email: account[1].email, isAdmin: false },
        {
          $set: {
            resetPasswordTokenHash: createHash("sha256")
              .update(token)
              .digest("hex"),
            resetPasswordExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
          },
        },
      );
      assert.equal(result.matchedCount, 1);
      res.json({ token });
    } catch (error) {
      next(error);
    }
  });
  harness.post("/__e2e/reset", async (_req, res, next) => {
    try {
      assertIsolated();
      await Promise.all(models.map((model) => model.collection.deleteMany({})));
      await User.create(
        Object.entries(accounts).map(([key, account]) => ({
          _id: oid(ids[key as "admin" | "a" | "b"]),
          name: "E2E " + key,
          email: account.email,
          password,
          isAdmin: key === "admin",
        })),
      );
      const now = new Date();
      const products = await Product.create(
        Array.from({ length: 17 }, (_, index) => ({
          _id: oid(
            index === 16
              ? ids.inactive
              : "2000000000000000000000" +
                  (index + 1).toString().padStart(2, "0"),
          ),
          name:
            index === 0
              ? "Alpha Chair"
              : index === 1
                ? "Bravo Lamp"
                : index === 16
                  ? "Hidden Fixture"
                  : "Widget " + String(index).padStart(2, "0"),
          sku: "E2E-" + index,
          slug: "e2e-" + index,
          description: "Isolated E2E fixture",
          category: index < 2 ? "Home" : "Tech",
          price: (index + 1) * 25,
          stock: index === 1 ? 1 : index === 2 ? 0 : 10,
          isActive: index !== 16,
          createdAt: now,
          images:
            index === 1
              ? [
                  {
                    url: "http://127.0.0.1:4400/__e2e/missing.png",
                    alt: "Broken fixture",
                    isPrimary: true,
                  },
                ]
              : [],
        })),
      );
      const statuses = [
        "pending",
        "confirmed",
        "shipped",
        "delivered",
        "delivered",
        "cancelled",
      ] as const;
      const orders = await Order.create(
        Array.from({ length: 15 }, (_, index) => ({
          _id: oid(
            "3000000000000000000000" + (index + 1).toString().padStart(2, "0"),
          ),
          user: oid(index === 14 ? ids.b : ids.a),
          items: [
            {
              product: products[0]!._id,
              name: index === 14 ? "B Private Item" : "Alpha Chair",
              sku: "E2E-0",
              price: 25,
              quantity: 1,
            },
          ],
          shippingAddress: {
            fullName: "E2E Fixture",
            phone: "09123456789",
            addressLine1: "E2E Street",
            city: "Manila",
            province: "Manila",
            postalCode: "1000",
          },
          paymentMethod: "COD" as const,
          orderStatus: statuses[index % statuses.length],
          paymentStatus:
            index % 6 === 4 ? ("paid" as const) : ("unpaid" as const),
          subtotal: 25,
          shippingFee: 0,
          total: 25,
          createdAt: now,
          ...(index % 6 === 4
            ? { paidAt: now, paymentCollectedBy: oid(ids.admin) }
            : {}),
        })),
      );
      application = loadApp();
      res.json({
        ids,
        accounts,
        tokens,
        expiredToken: jwt.sign({ id: ids.a, isAdmin: false }, fixtureSecret, {
          expiresIn: -10,
        }),
        orders: orders.map((order) => ({
          id: String(order._id),
          status: order.orderStatus,
          payment: order.paymentStatus,
          user: String(order.user),
        })),
      });
    } catch (error) {
      next(error);
    }
  });
  harness.get("/__e2e/state", async (_req, res) => {
    assertIsolated();
    res.json({
      products: await Product.find().lean(),
      orders: await Order.find().select("+paidAt +paymentCollectedBy").lean(),
      movements: await InventoryMovement.find().lean(),
      attempts: await CheckoutAttempt.find().lean(),
      carts: await Cart.find().lean(),
    });
  });
  harness.use((req, res, next) => application(req, res, next));
  server = harness.listen(4400, "127.0.0.1");
  await new Promise<void>((done, reject) => {
    server!.once("listening", done);
    server!.once("error", reject);
  });
  for (const [name, port] of [
    ["client", "4173"],
    ["admin", "4174"],
  ]) {
    const child = spawn(
      process.execPath,
      [
        resolve(root, name!, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        port!,
        "--strictPort",
        ...(name === "admin"
          ? ["--config", resolve(root, "admin/vite.e2e.config.ts")]
          : []),
      ],
      {
        cwd: resolve(root, name!),
        windowsHide: true,
        env: { ...process.env, VITE_API_URL: "http://127.0.0.1:4400/api" },
        stdio: "inherit",
      },
    );
    children.push(child);
    child.on("exit", (code) => {
      if (!closing) {
        console.error("E2E frontend exited:", name, code);
        void close().then(() => process.exit(1));
      }
    });
  }
  for (const port of [4173, 4174]) {
    let up = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}`)).ok) {
          up = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.ok(up, "E2E UI must become ready");
  }
  ready = true;
  console.log("Disposable ShopSphere E2E API ready on 127.0.0.1:4400");
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
main().catch((error) => {
  console.error(error);
  void close().then(() => process.exit(1));
});
