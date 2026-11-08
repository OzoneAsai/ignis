import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SidecarSupervisor } = require("./sidecar-supervisor");

const active = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 500) {
  const until = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < until) await sleep(5);
  expect(predicate()).toBe(true);
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.state = "stopped";
    this.starts = 0;
    this.stops = 0;
    this.failStarts = false;
    this.failHealth = false;
  }

  status() {
    return { state: this.state, pid: this.state === "running" ? 1234 : null, error: null };
  }

  async start() {
    this.starts += 1;
    if (this.failStarts) {
      this.state = "failed";
      throw new Error("Synthetic startup failure");
    }
    this.state = "running";
    return this.status();
  }

  async stop() {
    this.stops += 1;
    this.state = "stopped";
    return this.status();
  }

  async health() {
    if (this.failHealth) throw new Error("Synthetic heartbeat timeout");
    return this.status();
  }

  crash() {
    this.state = "failed";
    this.emit("exit", { intentional: false, code: 2 });
  }
}

function createSupervisor(driver, options = {}) {
  const supervisor = new SidecarSupervisor({
    processDriver: driver,
    healthIntervalMs: 100,
    initialRetryMs: 8,
    maxRetryMs: 40,
    maxRetries: 3,
    ...options,
  });
  active.push(supervisor);
  return supervisor;
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((supervisor) => supervisor.stop()));
});

describe("SidecarSupervisor", () => {
  it("starts once and recovers from an unexpected process exit", async () => {
    const driver = new FakeProcess();
    const supervisor = createSupervisor(driver);
    await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()]);
    expect(driver.starts).toBe(1);
    driver.crash();
    await waitFor(() => driver.starts === 2);
    expect(supervisor.status()).toMatchObject({ desired: true, state: "running" });
  });

  it("does not restart when deliberately disabled", async () => {
    const driver = new FakeProcess();
    const supervisor = createSupervisor(driver);
    await supervisor.start();
    await supervisor.stop();
    driver.crash();
    await sleep(60);
    expect(driver.starts).toBe(1);
    expect(supervisor.status().desired).toBe(false);
  });

  it("restarts a sidecar whose IPC health check fails", async () => {
    const driver = new FakeProcess();
    const supervisor = createSupervisor(driver);
    await supervisor.start();
    driver.failHealth = true;
    await supervisor.health();
    driver.failHealth = false;
    await waitFor(() => driver.starts === 2);
    expect(driver.stops).toBeGreaterThanOrEqual(1);
    expect(supervisor.status().state).toBe("running");
  });

  it("honors a bounded retry budget", async () => {
    const driver = new FakeProcess();
    const supervisor = createSupervisor(driver, { maxRetries: 2 });
    await supervisor.start();
    driver.failStarts = true;
    driver.crash();
    await waitFor(() => driver.starts === 3);
    await sleep(70);
    expect(driver.starts).toBe(3);
    expect(supervisor.status()).toMatchObject({
      desired: true, state: "failed", retries: 2, nextRetryAt: null,
    });
  });

  it("cancels a pending restart before stopping", async () => {
    const driver = new FakeProcess();
    const supervisor = createSupervisor(driver, { initialRetryMs: 80 });
    await supervisor.start();
    driver.crash();
    expect(supervisor.status().nextRetryAt).not.toBeNull();
    await supervisor.stop();
    await sleep(110);
    expect(driver.starts).toBe(1);
    expect(supervisor.status().nextRetryAt).toBeNull();
  });
});
