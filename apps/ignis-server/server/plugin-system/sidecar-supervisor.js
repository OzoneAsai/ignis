const { SidecarProcess } = require("./sidecar-process");

// The supervisor owns intent and recovery. The process driver only owns one
// particular child. This separation prevents a crash from disabling a plugin
// or silently changing Vault synchronization ownership.
class SidecarSupervisor {
  constructor(options = {}) {
    const {
      processDriver = new SidecarProcess(options),
      healthIntervalMs = 30_000,
      healthTimeoutMs = 2_000,
      initialRetryMs = 500,
      maxRetryMs = 30_000,
      maxRetries = 6,
      stableAfterMs = 60_000,
    } = options;
    this.driver = processDriver;
    this.healthIntervalMs = healthIntervalMs;
    this.healthTimeoutMs = healthTimeoutMs;
    this.initialRetryMs = initialRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.maxRetries = maxRetries;
    this.stableAfterMs = stableAfterMs;
    this.desired = false;
    this.retries = 0;
    this.nextRetryAt = null;
    this.lastError = null;
    this.healthySince = null;
    this.retryTimer = null;
    this.healthTimer = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.healthPromise = null;
    this.onExit = (event) => {
      if (this.desired && !event.intentional) {
        this.lastError = this.driver.status().error || "Sidecar exited";
        this.scheduleRetry();
      }
    };
    this.driver.on("exit", this.onExit);
  }

  status() {
    const process = this.driver.status();
    return {
      ...process,
      desired: this.desired,
      retries: this.retries,
      nextRetryAt: this.nextRetryAt,
      error: this.lastError || process.error,
    };
  }

  start() {
    this.desired = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.nextRetryAt = null;
    }
    if (this.startPromise) return this.startPromise;
    const attempt = this.ensureRunning();
    this.startPromise = attempt.finally(() => {
      if (this.startPromise === wrapped) this.startPromise = null;
    });
    const wrapped = this.startPromise;
    return wrapped;
  }

  async ensureRunning() {
    try {
      await this.driver.start();
      if (!this.desired) {
        await this.driver.stop();
        return this.status();
      }
      this.lastError = null;
      this.healthySince = Date.now();
      this.startMonitoring();
      return this.status();
    } catch (error) {
      this.lastError = error.message;
      this.scheduleRetry();
      throw error;
    }
  }

  startMonitoring() {
    if (this.healthTimer || !this.desired) return;
    this.healthTimer = setInterval(() => {
      void this.health().catch(() => {});
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  async health() {
    if (this.healthPromise) return this.healthPromise;
    const check = this.checkHealth();
    const wrapped = check.finally(() => {
      if (this.healthPromise === wrapped) this.healthPromise = null;
    });
    this.healthPromise = wrapped;
    return wrapped;
  }

  async checkHealth() {
    if (!this.desired || this.stopPromise) return this.status();
    if (this.driver.status().state !== "running") {
      this.scheduleRetry();
      return this.status();
    }
    try {
      await this.driver.health(this.healthTimeoutMs);
      if (this.healthySince !== null &&
          Date.now() - this.healthySince >= this.stableAfterMs) {
        this.retries = 0;
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      // A stuck process is not healthy. Stop it before launching a replacement.
      await this.driver.stop();
      this.scheduleRetry();
    }
    return this.status();
  }

  request(method, params, timeoutMs) {
    if (!this.desired || this.driver.status().state !== "running") {
      return Promise.reject(new Error("Sidecar not running"));
    }
    return this.driver.request(method, params, timeoutMs);
  }

  scheduleRetry() {
    if (!this.desired || this.retryTimer || this.stopPromise) return;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.retries >= this.maxRetries) {
      this.lastError ||= "Sidecar retry budget exhausted";
      return;
    }
    const delay = Math.min(
      this.maxRetryMs,
      this.initialRetryMs * Math.pow(2, this.retries),
    );
    this.retries += 1;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      if (!this.desired) return;
      void this.start().catch(() => {});
    }, delay);
    this.retryTimer.unref?.();
  }

  stop() {
    this.desired = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.retryTimer = null;
    this.healthTimer = null;
    this.nextRetryAt = null;
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.shutdown();
    this.stopPromise = stopping.finally(() => {
      if (this.stopPromise === wrapped) this.stopPromise = null;
    });
    const wrapped = this.stopPromise;
    return wrapped;
  }

  async shutdown() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    await this.driver.stop();
    this.healthySince = null;
    this.retries = 0;
    this.lastError = null;
    return this.status();
  }
}

module.exports = { SidecarSupervisor };
