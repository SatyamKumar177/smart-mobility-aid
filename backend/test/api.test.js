import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import bcrypt from "bcryptjs";
import { io as socketClient } from "socket.io-client";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  app,
  server,
  User,
  Device,
  Reading,
  markOfflineDevices,
} from "../src/index.js";

let mongo, adminToken, caretakerToken, apiKey, port;

beforeAll(async () => {
  const dbPath = resolve(process.cwd(), ".mongodb-memory-test");
  await mkdir(dbPath, { recursive: true });
  mongo = await MongoMemoryServer.create({ instance: { dbPath } });
  await mongoose.connect(mongo.getUri());
  await new Promise((resolveListen) => server.listen(0, resolveListen));
  port = server.address().port;

  const admin = await User.create({
    name: "Admin",
    email: "admin@test.local",
    passwordHash: await bcrypt.hash("password123", 4),
    role: "admin",
  });
  const caretaker = await User.create({
    name: "Caretaker",
    email: "care@test.local",
    passwordHash: await bcrypt.hash("password123", 4),
    role: "caretaker",
  });
  adminToken = (
    await request(app)
      .post("/api/auth/login")
      .send({ email: admin.email, password: "password123" })
  ).body.token;
  caretakerToken = (
    await request(app)
      .post("/api/auth/login")
      .send({ email: caretaker.email, password: "password123" })
  ).body.token;
  apiKey = "test-device-secret";
  await Device.create({
    deviceId: "test-01",
    name: "Test Device",
    owner: caretaker._id,
    apiKeyHash: await bcrypt.hash(apiKey, 4),
    lastSeenAt: new Date(),
  });
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (mongo) await mongo.stop();
  await rm(resolve(process.cwd(), ".mongodb-memory-test"), {
    recursive: true,
    force: true,
  });
});
beforeEach(async () => Reading.deleteMany({}));
const userHeaders = (token = caretakerToken) => ({
  Authorization: `Bearer ${token}`,
});

describe("mobility API", () => {
  it("logs in and rejects bad passwords", async () => {
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ email: "admin@test.local", password: "password123" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ email: "admin@test.local", password: "wrong" })
      ).status,
    ).toBe(401);
  });
  it("enforces the login rate limit", async () => {
    for (let i = 0; i < 10; i++)
      await request(app)
        .post("/api/auth/login")
        .send({ email: "missing@test.local", password: "bad" });
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ email: "missing@test.local", password: "bad" })
      ).status,
    ).toBe(429);
  });
  it("requires a device key and stores batches including null sensor values", async () => {
    expect(
      (
        await request(app)
          .post("/api/readings")
          .send({ left: 1, front: 1, right: 1 })
      ).status,
    ).toBe(401);
    const response = await request(app)
      .post("/api/readings")
      .set("x-api-key", apiKey)
      .send([
        { left: null, front: 45, right: 90 },
        { left: 30, front: 22, right: null },
      ]);
    expect(response.status).toBe(201);
    expect(response.body.accepted).toBe(2);
    expect((await Reading.findOne({ left: null })).front).toBe(45);
  });
  it("rejects malformed reading batches with a zod error", async () => {
    expect(
      (
        await request(app)
          .post("/api/readings")
          .set("x-api-key", apiKey)
          .send([{ left: -1, front: 2, right: 3 }])
      ).status,
    ).toBe(400);
  });
  it("enforces user and device config permissions and validates config", async () => {
    const id = (await Device.findOne()).id;
    expect(
      (
        await request(app)
          .get("/api/devices/me/config")
          .set("x-api-key", "wrong")
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/devices/me/config")
          .set("x-api-key", apiKey)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/api/devices/${id}/config`)
          .send({ intensity: 50 })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .patch(`/api/devices/${id}/config`)
          .set(userHeaders())
          .send({ intensity: 80 })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/api/devices/${id}/config`)
          .set(userHeaders(adminToken))
          .send({ intensity: 900 })
      ).status,
    ).toBe(400);
  });
  it("accepts each alert type and acknowledges an assigned device alert", async () => {
    for (const type of ["danger", "low_battery", "sos", "sensor_fault"])
      expect(
        (
          await request(app)
            .post("/api/alerts")
            .set("x-api-key", apiKey)
            .send({ type })
        ).status,
      ).toBe(201);
    const alert = (await request(app).get("/api/alerts").set(userHeaders()))
      .body[0];
    expect(
      (
        await request(app)
          .patch(`/api/alerts/${alert._id}/ack`)
          .set(userHeaders())
      ).body.alert.acknowledged,
    ).toBe(true);
  });
  it("returns history statistics", async () => {
    await request(app)
      .post("/api/readings")
      .set("x-api-key", apiKey)
      .send([{ left: 50, front: 60, right: 70, zone: "danger" }]);
    expect(
      (await request(app).get("/api/readings/stats").set(userHeaders())).status,
    ).toBe(200);
  });
  it("broadcasts readings over Socket.IO", async () => {
    const client = socketClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      auth: { token: caretakerToken },
    });
    await new Promise((resolveConnect, reject) => {
      client.on("connect", resolveConnect);
      client.on("connect_error", reject);
    });
    const event = new Promise((resolveEvent) =>
      client.once("reading", resolveEvent),
    );
    await request(app)
      .post("/api/readings")
      .set("x-api-key", apiKey)
      .send([{ left: 12, front: null, right: 45 }]);
    expect((await event).front).toBeNull();
    client.disconnect();
  });
  it("marks a device offline after 15 seconds and emits status", async () => {
    const device = await Device.findOne({ deviceId: "test-01" });
    device.lastSeenAt = new Date();
    await device.save();
    const client = socketClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      auth: { token: caretakerToken },
    });
    await new Promise((resolveConnect, reject) => {
      client.on("connect", resolveConnect);
      client.on("connect_error", reject);
    });
    const event = new Promise((resolveEvent) =>
      client.once("device:status", resolveEvent),
    );
    expect(await markOfflineDevices(new Date(Date.now() + 16000))).toBe(1);
    expect(await event).toEqual({ deviceId: "test-01", status: "offline" });
    expect((await Device.findById(device.id)).lastSeenAt).toBeNull();
    client.disconnect();
  });
  it("allows only admins to start and stop the simulated demo", async () => {
    expect(
      (await request(app).post("/api/demo/start").set(userHeaders()).send({}))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/demo/start")
          .set(userHeaders(adminToken))
          .send({})
      ).body.simulated,
    ).toBe(true);
    expect(
      (
        await request(app)
          .post("/api/demo/stop")
          .set(userHeaders(adminToken))
          .send({})
      ).body.running,
    ).toBe(false);
  });
  it("seeds the demo accounts and prints the device key once", async () => {
    const result = spawnSync(process.execPath, ["src/seed.js"], {
      cwd: process.cwd(),
      env: { ...process.env, MONGODB_URI: mongo.getUri() },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Device API key (shown once):");
    expect(
      await Device.findOne({ deviceId: "MOBILITY-DEMO-01" }),
    ).not.toBeNull();
    expect(await User.findOne({ email: "admin@example.com" })).not.toBeNull();
  });
  it("runs the device simulator against the API", async () => {
    const child = spawn(process.execPath, ["simulator/device.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${port}`,
        DEVICE_API_KEY: apiKey,
      },
      stdio: "ignore",
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1800));
    child.kill();
    expect(await Reading.countDocuments()).toBeGreaterThan(0);
  });
  it("serves health and maintains the TTL index", async () => {
    expect([200, 503]).toContain(
      (await request(app).get("/api/health")).status,
    );
    const indexes = await Reading.collection.indexes();
    expect(indexes.some((index) => index.expireAfterSeconds === 2592000)).toBe(
      true,
    );
  });
});
