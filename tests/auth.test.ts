import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, type IUser } from "../src/models/user.model";
import authRoutes from "../src/routes/auth.routes";
import cartRoutes from "../src/routes/cart.routes";
import orderRoutes from "../src/routes/order.routes";
import { AuthController } from "../src/controllers/auth.controller";
import { AuthService } from "../src/services/auth.service";
import { protect } from "../src/middleware/auth.middleware";
import {
  createAuthRateLimiter,
  LOGIN_RATE_LIMIT,
  REGISTRATION_RATE_LIMIT,
} from "../src/middleware/authRateLimit";
import {
  AuthValidationError,
  validateLogin,
  validateRegistration,
} from "../src/validators/auth.validation";

// Real validators, bcrypt, JWTs, parsers, middleware and controllers. In-memory
// Mongoose documents only: no .env loading, MongoDB connection, or data writes.
const secret = "shopsphere-auth-tests-only";
const previousSecret = process.env.JWT_SECRET;
const users = new Map<string, IUser>();
let queries = 0;
let databaseFails = false;
let duplicateSave = false;
const privateError = "private database diagnostics and connection details";
let clock = 1000;
const app = express();
app.use("/api/auth", authRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.get("/protected", protect, (req, res) => {
  res.json({ allowed: true });
});
// Controller/validation cases are isolated from the real route's IP budget;
// production wiring and actual limits are exercised separately below.
app.use(express.json({ strict: false }));
app.post("/validation/login", AuthController.login);
app.post("/validation/register", AuthController.register);
app.post(
  "/retry",
  createAuthRateLimiter({ limit: 2, windowMs: 2000, now: () => clock }),
  (_req, res) => res.json({ allowed: true }),
);
app.post(
  "/capacity",
  createAuthRateLimiter({
    limit: 1,
    windowMs: 2000,
    maxKeys: 0,
    now: () => clock,
  }),
  (_req, res) => res.json({ allowed: true }),
);
const server = app.listen(0, "127.0.0.1");

before(() => {
  process.env.JWT_SECRET = secret;
  mock.method(User, "findOne", async (query: { email: unknown }) => {
    queries++;
    assert.equal(typeof query.email, "string");
    if (databaseFails) throw new Error(privateError);
    return users.get(String(query.email)) ?? null;
  });
  mock.method(User, "findById", (id: unknown) => ({
    select: (projection: string) => ({
      lean: async () => {
        queries++;
        if (databaseFails) throw new Error(privateError);
        const user = [...users.values()].find(
          (user) => String(user._id) === id,
        );
        if (!user) return null;
        if (projection === "isAdmin") return { isAdmin: user.isAdmin };
        assert.equal(projection, "-password");
        const safe = user.toObject();
        delete (safe as Partial<IUser>).password;
        return safe;
      },
    }),
  }));
  mock.method(User.prototype, "save", async function (this: IUser) {
    if (databaseFails) throw new Error(privateError);
    if (duplicateSave)
      throw Object.assign(new Error(privateError), { code: 11000 });
    users.set(this.email, this);
    return this;
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  mock.restoreAll();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function request(
  path: string,
  body?: unknown,
  authorization?: string,
  rawBody?: string,
) {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  return fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    {
      method: body === undefined && rawBody === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      },
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    },
  );
}

test("valid registration normalizes inputs, hashes the password and ignores injected roles", async () => {
  const response = await request("/api/auth/register", {
    name: "  Jane Fixture  ",
    email: "  JANE@Example.Test  ",
    password: "Password1",
    isAdmin: true,
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.user.name, "Jane Fixture");
  assert.equal(body.user.email, "jane@example.test");
  assert.equal(body.user.isAdmin, false);
  assert.equal(body.user.password, undefined);
  assert.equal(typeof body.token, "string");
  const claims = jwt.verify(body.token, secret);
  assert.ok(typeof claims !== "string");
  assert.equal(claims.id, body.user._id);
  assert.equal(claims.isAdmin, false);
  assert.equal(claims.exp! - claims.iat!, 7 * 24 * 60 * 60);
  const user = users.get("jane@example.test")!;
  assert.notEqual(user.password, "Password1");
  assert.equal(bcrypt.getRounds(user.password), 10);
  assert.equal(await bcrypt.compare("Password1", user.password), true);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("valid client/admin login preserves response shape and existing weak/long passwords", async () => {
  for (const [email, password, isAdmin] of [
    ["jane@example.test", "Password1", false],
    ["admin@example.test", "old", true],
    ["long@example.test", "x".repeat(100), false],
    ["spaces@example.test", " old password ", false],
  ] as const) {
    if (!users.has(email))
      users.set(
        email,
        new User({
          name: "Existing fixture",
          email,
          password: await bcrypt.hash(password, 4),
          isAdmin,
        }),
      );
    const response = await request(
      email.startsWith("jane") ? "/api/auth/login" : "/validation/login",
      { email: ` ${email.toUpperCase()} `, password },
    );
    assert.equal(response.status, 200, email);
    const body = await response.json();
    assert.equal(body.user.email, email);
    assert.equal(body.user.isAdmin, isAdmin);
    assert.equal(body.user.password, undefined);
    assert.equal(typeof body.token, "string");
  }
});

test("malformed bodies and structured selectors fail before database queries or hashing", async (t) => {
  const salt = t.mock.method(bcrypt, "genSalt", () => {
    throw new Error("Unexpected hashing");
  });
  const compare = t.mock.method(bcrypt, "compare", () => {
    throw new Error("Unexpected compare");
  });
  const invalid: unknown[] = [
    null,
    [],
    "text",
    3,
    {},
    { email: "jane@example.test" },
    { password: "Password1" },
  ];
  for (const value of [
    null,
    [],
    {},
    { $ne: "" },
    ["jane@example.test"],
    12,
    true,
  ]) {
    invalid.push(
      { email: value, password: "Password1", name: "Jane" },
      { email: "jane@example.test", password: value, name: "Jane" },
    );
  }
  const beforeQueries = queries;
  for (const body of invalid) {
    for (const endpoint of ["login", "register"]) {
      const response = await request(`/validation/${endpoint}`, body);
      assert.equal(
        response.status,
        400,
        `${endpoint}: ${JSON.stringify(body)}`,
      );
      assert.equal(typeof (await response.json()).message, "string");
    }
  }
  for (const name of [null, [], {}, 123]) {
    assert.equal(
      (
        await request("/validation/register", {
          name,
          email: "jane@example.test",
          password: "Password1",
        })
      ).status,
      400,
    );
  }
  await assert.rejects(
    AuthService.login({ $ne: "" }, "Password1"),
    AuthValidationError,
  );
  await assert.rejects(
    AuthService.register({
      name: "Jane",
      email: "jane@example.test",
      password: {},
    }),
    AuthValidationError,
  );
  assert.equal(queries, beforeQueries);
  assert.equal(salt.mock.callCount(), 0);
  assert.equal(compare.mock.callCount(), 0);
});

test("email, name and password boundaries are enforced without trimming passwords", () => {
  const registration = {
    name: "Jo",
    email: "a@example.test",
    password: "A1234567",
  };
  for (const email of [
    "",
    "invalid",
    "a@@example.test",
    "a b@example.test",
    ".a@example.test",
    "a..b@example.test",
    "a@-example.test",
    `${"a".repeat(65)}@example.test`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ]) {
    assert.throws(
      () => validateLogin({ email, password: "old" }),
      AuthValidationError,
    );
  }
  for (const password of [
    "",
    "A123456",
    "abcdefgh1",
    "Abcdefgh",
    "A1" + "x".repeat(71),
    "A1" + "é".repeat(36),
    "A123456\0",
  ]) {
    assert.throws(
      () => validateRegistration({ ...registration, password }),
      AuthValidationError,
    );
  }
  assert.equal(
    validateRegistration({ ...registration, password: "A1" + "x".repeat(70) })
      .password.length,
    72,
  );
  assert.equal(
    Buffer.byteLength(
      validateRegistration({ ...registration, password: "A1" + "é".repeat(35) })
        .password,
    ),
    72,
  );
  assert.equal(
    validateLogin({ email: registration.email, password: " " }).password,
    " ",
  );
  assert.equal(
    validateLogin({ email: registration.email, password: "x".repeat(1024) })
      .password.length,
    1024,
  );
  assert.throws(
    () =>
      validateLogin({ email: registration.email, password: "x".repeat(1025) }),
    AuthValidationError,
  );
  for (const name of ["", "x", "x".repeat(101), "Jane\nFixture"])
    assert.throws(
      () => validateRegistration({ ...registration, name }),
      AuthValidationError,
    );
});

test("invalid credentials use identical safe errors and both perform bcrypt comparisons", async (t) => {
  const original = bcrypt.compare;
  const compare = t.mock.method(bcrypt, "compare", original);
  for (const email of ["jane@example.test", "missing@example.test"]) {
    const response = await request("/validation/login", {
      email,
      password: "WrongPassword1",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      message: "Invalid email or password",
    });
  }
  assert.equal(compare.mock.callCount(), 2);
});

test("duplicate registration, duplicate-key races and internal failures return safe errors", async () => {
  const duplicate = await request("/validation/register", {
    name: "Jane",
    email: "jane@example.test",
    password: "Password1",
  });
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await duplicate.json(), {
    message: "Unable to register with these details.",
  });
  duplicateSave = true;
  try {
    const race = await request("/validation/register", {
      name: "Jane",
      email: "race@example.test",
      password: "Password1",
    });
    assert.equal(race.status, 400);
    assert.deepEqual(await race.json(), {
      message: "Unable to register with these details.",
    });
  } finally {
    duplicateSave = false;
  }
  databaseFails = true;
  try {
    for (const endpoint of ["login", "register"]) {
      const failure = await request(`/validation/${endpoint}`, {
        name: "Jane",
        email: "safe@example.test",
        password: "Password1",
      });
      assert.equal(failure.status, 500);
      assert.deepEqual(await failure.json(), {
        message: "Authentication unavailable. Please try again.",
      });
    }
  } finally {
    databaseFails = false;
  }
});

test("auth JSON parsing is bounded and returns sanitized errors", async () => {
  const malformed = await request(
    "/api/auth/login",
    undefined,
    undefined,
    '{"password":"DO-NOT-ECHO",',
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    message: "A valid JSON request is required.",
  });
  const large = await request("/api/auth/register", {
    name: "Jane",
    email: "large@example.test",
    password: "x".repeat(9000),
  });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), {
    message: "Authentication request is too large.",
  });
});

test("deleted accounts lose access to profile, cart and orders with otherwise valid JWTs", async () => {
  const user = new User({
    name: "Revocable",
    email: "revocable@example.test",
    password: "unused",
    isAdmin: false,
  });
  users.set(user.email, user);
  const token = jwt.sign({ id: String(user._id), isAdmin: false }, secret, {
    expiresIn: "1h",
  });
  assert.equal((await request("/protected", undefined, token)).status, 200);
  assert.equal((await request("/api/auth/me", undefined, token)).status, 200);
  users.delete(user.email);
  for (const path of [
    "/protected",
    "/api/auth/me",
    "/api/cart",
    "/api/orders/my",
    `/api/orders/${String(user._id)}`,
  ]) {
    const response = await request(path, undefined, token);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), {
      message: "Authentication required",
    });
  }
  const cartWrite = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cart`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [] }),
    },
  );
  assert.equal(cartWrite.status, 401);
  assert.equal((await request("/api/orders", {}, token)).status, 401);
});

test("protected database failures fail closed without exposing diagnostics", async () => {
  databaseFails = true;
  try {
    const token = jwt.sign(
      { id: String(users.get("jane@example.test")!._id) },
      secret,
    );
    const response = await request("/protected", undefined, token);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message: "Unable to authenticate. Please try again.",
    });
  } finally {
    databaseFails = false;
  }
});

test("real login and registration routes throttle independently before validation", async () => {
  for (const [endpoint, policy] of [
    ["login", LOGIN_RATE_LIMIT],
    ["register", REGISTRATION_RATE_LIMIT],
  ] as const) {
    let blocked = false;
    for (let attempt = 0; attempt <= policy.limit; attempt++) {
      const beforeQueries = queries;
      const response = await request(`/api/auth/${endpoint}`, {});
      if (response.status === 429) {
        blocked = true;
        assert.equal(queries, beforeQueries);
        assert.ok(Number(response.headers.get("retry-after")) > 0);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
          message: "Too many authentication attempts. Please try again later.",
        });
        break;
      }
      assert.equal(response.status, 400);
    }
    assert.ok(blocked, endpoint);
  }
});

test("fixed windows enforce exact limits, ignore spoofed forwarding headers and permit retry", async () => {
  for (const status of [200, 200, 429])
    assert.equal((await request("/retry", {})).status, status);
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/retry`;
  const spoofed = await fetch(address, {
    method: "POST",
    headers: { "X-Forwarded-For": "203.0.113.55" },
  });
  assert.equal(spoofed.status, 429);
  assert.equal(spoofed.headers.get("retry-after"), "2");
  clock += 1000;
  assert.equal((await request("/retry", {})).headers.get("retry-after"), "1");
  clock += 1000;
  assert.equal((await request("/retry", {})).status, 200);
  assert.equal((await request("/capacity", {})).status, 429);
});
