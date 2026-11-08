const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

const PROTOCOL = "ignis-sidecar-v1";
const ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
];

// Runs the plugin code in its own Node process. A sidecar cannot install
// Express routes or obtain direct filesystem/server objects via register().
// This is the local-process driver; an OS-supervised external driver is a
// separate deployment strategy and must verify its instance before attaching.
class SidecarProcess extends EventEmitter {
  constructor({ id, entry, dataDir, spawnProcess = spawn, executable = process.execPath,
    readyTimeoutMs = 5_000, stopTimeoutMs = 2_000 } = {}) {
    super();
    this.id = id;
    this.entry = entry;
    this.dataDir = dataDir;
    this.spawnProcess = spawnProcess;
    this.executable = executable;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.child = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.state = "stopped";
    this.lastError = null;
    this.stopRequested = false;
  }

  status() {
    return { state: this.state, pid: this.child?.pid ?? null, error: this.lastError };
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.state === "running" && this.child) return Promise.resolve(this.status());
    this.startPromise = this.launch().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async launch() {
    if (this.stopPromise) await this.stopPromise;
    if (this.child) {
      throw new Error("Previous sidecar process has not exited");
    }
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    this.state = "starting";
    this.lastError = null;
    this.stopRequested = false;
    let child;
    try {
      // Do not pass IGNIS_SYNC_TOKEN or other server credentials to plugins.
      const env = {};
      for (const key of ENV_ALLOWLIST) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      child = this.spawnProcess(this.executable, [this.entry], {
        cwd: path.dirname(this.entry),
        env: { ...env, IGNIS_SIDECAR_ID: this.id,
          IGNIS_SIDECAR_DATA_DIR: this.dataDir },
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (e) {
      this.state = "failed";
      this.lastError = e.message;
      throw e;
    }
    this.child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const onExit = (code, signal) => {
        const intentional = this.stopRequested;
        if (this.child === child) {
          this.child = null;
          this.state = intentional ? "stopped" : "failed";
          this.lastError = intentional ? null
            : this.lastError || `Sidecar exited (${code ?? signal ?? "unknown"})`;
        }
        if (!settled) fail(new Error(`Sidecar exited before ready (${code ?? signal ?? "unknown"})`));
        child.off("error", onError);
        this.emit("exit", { code, signal, intentional });
      };
      const cleanupStartup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        if (this.child === child) {
          this.state = "failed";
          this.lastError = error.message;
        }
        child.kill("SIGTERM");
        // A worker that ignores SIGTERM must not remain as an orphan or be
        // duplicated by the next supervisor restart attempt.
        const force = setTimeout(() => {
          if (this.child === child) child.kill("SIGKILL");
        }, this.stopTimeoutMs);
        force.unref?.();
        child.once("close", () => {
          clearTimeout(force);
          if (this.child === child) this.child = null;
        });
        reject(error);
      };
      const onError = (error) => {
        if (!settled) fail(error);
        else {
          this.state = "failed";
          this.lastError = error.message;
          this.emit("fault", error);
        }
      };
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        if (message.protocol !== PROTOCOL || message.id !== this.id) {
          fail(new Error("Sidecar identity or protocol mismatch"));
          return;
        }
        if (settled) return;
        settled = true;
        cleanupStartup();
        this.state = "running";
        resolve(this.status());
      };
      child.on("message", onMessage);
      child.on("error", onError);
      child.once("exit", onExit);
      timer = setTimeout(() => fail(new Error("Sidecar ready handshake timed out")),
        this.readyTimeoutMs);
      timer.unref?.();
    });
  }

  // IPC health is an explicit round trip. Being a live PID is not sufficient.
  health(timeoutMs = 2_000) {
    const child = this.child;
    if (this.state !== "running" || !child?.connected) {
      return Promise.reject(new Error("Sidecar IPC is unavailable"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return false;
        finished = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("disconnect", onDisconnect);
        return true;
      };
      const fail = (reason) => { if (cleanup()) reject(reason); };
      const onMessage = (message) => {
        if (message?.type !== "pong" || message.requestId !== requestId) return;
        if (message.protocol !== PROTOCOL || message.id !== this.id) {
          fail(new Error("Sidecar health identity mismatch"));
        } else if (cleanup()) {
          resolve(this.status());
        }
      };
      const onExit = () => fail(new Error("Sidecar exited during health check"));
      const onDisconnect = () => fail(new Error("Sidecar IPC disconnected"));
      const timer = setTimeout(() => fail(new Error("Sidecar health timed out")), timeoutMs);
      timer.unref?.();
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("disconnect", onDisconnect);
      try {
        child.send({ type: "ping", protocol: PROTOCOL, requestId }, (err) => {
          if (err) fail(err);
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  // Bounded request/response over the already-attested private child channel.
  // The worker must separately allowlist which operations it accepts.
  request(method, params = {}, timeoutMs = 5_000) {
    const child = this.child;
    if (this.state !== "running" || !child?.connected) {
      return Promise.reject(new Error("Sidecar IPC is unavailable"));
    }
    if (typeof method !== "string" || !/^[a-z][a-zA-Z0-9]{0,63}$/.test(method)) {
      return Promise.reject(new Error("Invalid sidecar RPC method"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("disconnect", onDisconnect);
        return true;
      };
      const fail = (error) => { if (cleanup()) reject(error); };
      const onMessage = (reply) => {
        if (reply?.type !== "rpc-result" || reply.requestId !== requestId) return;
        if (reply.protocol !== PROTOCOL || reply.id !== this.id) {
          fail(new Error("Sidecar RPC identity mismatch"));
        } else if (reply.ok !== true) {
          fail(new Error(typeof reply.error === "string" ? reply.error : "Sidecar RPC failed"));
        } else if (cleanup()) {
          resolve(reply.result);
        }
      };
      const onExit = () => fail(new Error("Sidecar exited during RPC"));
      const onDisconnect = () => fail(new Error("Sidecar IPC disconnected"));
      const timer = setTimeout(() => fail(new Error("Sidecar RPC timed out")), timeoutMs);
      timer.unref?.();
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("disconnect", onDisconnect);
      try {
        child.send({ type: "rpc", protocol: PROTOCOL, requestId, method, params },
          (error) => { if (error) fail(error); });
      } catch (error) {
        fail(error);
      }
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.terminate().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async terminate() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    const child = this.child;
    if (!child) {
      if (this.state !== "failed") this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.stopRequested = true;
    await new Promise((resolve) => {
      let finished = false;
      let forceTimer;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        child.off("exit", done);
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.child === child) child.kill("SIGTERM");
        forceTimer = setTimeout(() => {
          if (this.child === child) child.kill("SIGKILL");
          done();
        }, this.stopTimeoutMs);
      }, this.stopTimeoutMs);
      child.once("exit", done);
      if (!child.connected) {
        child.kill("SIGTERM");
      } else {
        child.send({ type: "shutdown", protocol: PROTOCOL }, (err) => {
          if (err && this.child === child) child.kill("SIGTERM");
        });
      }
    });
    if (this.child === child) {
      this.child = null;
      this.state = "stopped";
    }
  }
}

module.exports = { SidecarProcess, PROTOCOL };
