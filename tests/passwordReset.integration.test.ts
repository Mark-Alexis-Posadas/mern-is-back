import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import express from "express";
import mongoose from "mongoose";
import { User } from "../src/models/user.model";
import authRoutes from "../src/routes/auth.routes";
import { startCartReplicaSet } from "./helpers/cartReplicaSet";

const secret = "shopsphere-password-reset-isolated-test-secret";
const previousSecret = process.env.JWT_SECRET;
const previousResendKey = process.env.RESEND_API_KEY;
const previousFrom = process.env.PASSWORD_RESET_FROM;
const previousClientUrl = process.env.CLIENT_URL;
let stop: (() => Promise<void>) | undefined;
let http: Server | undefined;
let base = "";

before(
  async () => {
    stop = await startCartReplicaSet();
    assert.equal(mongoose.connection.name, "cart_concurrency_test");
    await User.createIndexes();
    process.env.JWT_SECRET = secret;
    process.env.RESEND_API_KEY = "isolated-test-key";
    process.env.PASSWORD_RESET_FROM = "ShopSphere <test@example.test>";
    process.env.CLIENT_URL = "https://shop.example.test";

    const app = express();
    app.use("/api/auth", authRoutes);
    http = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http!.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/auth`;
  },
  { timeout: 60_000 },
);

after(async () => {
  if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
  if (stop) await stop();
  for (const [key, value] of [
    ["JWT_SECRET", previousSecret],
    ["RESEND_API_KEY", previousResendKey],
    ["PASSWORD_RESET_FROM", previousFrom],
    ["CLIENT_URL", previousClientUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Mongo-backed reset is generic, expiring, single-use, and revokes old sessions", async (t) => {
  assert.equal(mongoose.connection.name, "cart_concurrency_test");
  await User.deleteMany({});
  const customer = await User.create({
    name: "Reset Customer",
    email: "reset-customer@example.test",
    password: await bcrypt.hash("OldPassword1", 10),
    isAdmin: false,
  });
  const admin = await User.create({
    name: "Reset Admin",
    email: "reset-admin@example.test",
    password: await bcrypt.hash("AdminPassword1", 10),
    isAdmin: true,
  });
  const expiredCustomer = await User.create({
    name: "Expired Reset Customer",
    email: "expired-reset@example.test",
    password: await bcrypt.hash("OldPassword1", 10),
    isAdmin: false,
  });
  const expiredToken = "e".repeat(64);
  await User.updateOne(
    { _id: expiredCustomer._id },
    {
      $set: {
        resetPasswordTokenHash: createHash("sha256")
          .update(expiredToken)
          .digest("hex"),
        resetPasswordExpiresAt: new Date(Date.now() - 1000),
      },
    },
  );

  const sentMessages: string[] = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("https://api.resend.com/")) {
        sentMessages.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }
      return nativeFetch(url, init);
    },
  );

  const forgot = async (email: string) =>
    fetch(`${base}/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  const [existing, missing, adminRequest] = await Promise.all([
    forgot(customer.email),
    forgot("missing@example.test"),
    forgot(admin.email),
  ]);
  assert.deepEqual(
    [existing.status, missing.status, adminRequest.status],
    [200, 200, 200],
  );
  const publicResponse = await missing.json();
  assert.deepEqual(await existing.json(), publicResponse);
  assert.deepEqual(await adminRequest.json(), publicResponse);
  assert.equal(sentMessages.length, 1);

  const emailText = JSON.parse(sentMessages[0]!).text as string;
  const token = emailText.match(/token=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  const storedCustomer = await User.findById(customer._id).select(
    "+resetPasswordTokenHash +resetPasswordExpiresAt",
  );
  assert.equal(
    storedCustomer!.resetPasswordTokenHash,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.notEqual(storedCustomer!.resetPasswordTokenHash, token);
  assert.ok(storedCustomer!.resetPasswordExpiresAt!.getTime() > Date.now());
  assert.ok(
    storedCustomer!.resetPasswordExpiresAt!.getTime() <=
      Date.now() + 20 * 60 * 1000 + 1000,
  );
  const storedAdmin = await User.findById(admin._id).select(
    "+resetPasswordTokenHash",
  );
  assert.equal(storedAdmin!.resetPasswordTokenHash, undefined);

  const login = async (email: string, password: string) =>
    fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  const oldLogin = await login(customer.email, "OldPassword1");
  assert.equal(oldLogin.status, 200);
  const oldSession = (await oldLogin.json()).token as string;

  const reset = async (presentedToken: string, password: string) =>
    fetch(`${base}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: presentedToken, password }),
    });
  const invalid = await reset("f".repeat(64), "NewPassword2");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    message: "This reset link is invalid or expired.",
  });

  const expired = await reset(expiredToken, "NewPassword2");
  assert.equal(expired.status, 400);
  assert.deepEqual(await expired.json(), {
    message: "This reset link is invalid or expired.",
  });

  const weak = await reset(token, "weak");
  assert.equal(weak.status, 400);
  assert.ok((await weak.json()).message.includes("Password must"));

  const concurrent = await Promise.all([
    reset(token, "NewPassword2"),
    reset(token, "NewPassword2"),
  ]);
  assert.deepEqual(
    concurrent.map((response) => response.status).sort(),
    [200, 400],
  );
  const successBody = JSON.stringify(
    await concurrent.find((response) => response.status === 200)!.json(),
  );
  assert.ok(!successBody.includes(token));
  assert.ok(!successBody.includes("NewPassword2"));
  const reused = await reset(token, "NewPassword2");
  assert.equal(reused.status, 400);

  const oldSessionResponse = await fetch(`${base}/me`, {
    headers: { Authorization: `Bearer ${oldSession}` },
  });
  assert.equal(oldSessionResponse.status, 401);
  assert.equal((await login(customer.email, "OldPassword1")).status, 401);
  const newLogin = await login(customer.email, "NewPassword2");
  assert.equal(newLogin.status, 200);
  const newSession = (await newLogin.json()).token as string;
  const newSessionResponse = await fetch(`${base}/me`, {
    headers: { Authorization: `Bearer ${newSession}` },
  });
  assert.equal(newSessionResponse.status, 200);

  const limited = await forgot(customer.email);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    message: "Too many authentication attempts. Please try again later.",
  });
});
