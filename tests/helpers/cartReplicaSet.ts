import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import mongoose from "mongoose";

// Never reads MONGO_URI/.env. Only a new process, random loopback port, and
// unique temporary dbpath are used. Startup polling is not test synchronization.
export async function startCartReplicaSet() {
  const directory = await mkdtemp(join(tmpdir(), "shopsphere-cart-test-"));
  let mongo: ChildProcess | undefined;
  async function stop() {
    await mongoose.disconnect();
    if (mongo?.pid && mongo.exitCode === null) {
      const exited = new Promise<void>((done) =>
        mongo!.once("exit", () => done()),
      );
      mongo.kill();
      await exited;
    }
    const target = resolve(directory);
    const root = resolve(tmpdir()) + sep;
    assert.ok(
      target.startsWith(root) &&
        target.slice(root.length).startsWith("shopsphere-cart-test-"),
    );
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  try {
    const socket = createServer();
    await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((done) => socket.close(() => done()));
    await mkdir(join(directory, "db"));
    mongo = spawn(
      process.env.MONGOD_BINARY ?? "mongod",
      [
        "--replSet",
        "shopsphere_cart_test",
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--dbpath",
        join(directory, "db"),
        "--logpath",
        join(directory, "mongo.log"),
        "--oplogSize",
        "32",
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
        throw new Error("Isolated replica set exited during startup.");
      try {
        await mongoose.connect(
          `mongodb://127.0.0.1:${port}/cart_concurrency_test?directConnection=true`,
          { serverSelectionTimeoutMS: 500, autoIndex: false },
        );
        connected = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    assert.ok(
      connected,
      "Install mongod or configure MONGOD_BINARY for isolated transaction tests.",
    );
    const admin = mongoose.connection.db!.admin();
    await admin.command({
      replSetInitiate: {
        _id: "shopsphere_cart_test",
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
    let primary = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary) {
        primary = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(primary, "The disposable replica set must elect a primary.");
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
