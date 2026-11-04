import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  Setting: class {},
  Notice: class {},
  TFile: class {},
  editorInfoField: null,
  requestUrl: vi.fn()
}));
vi.mock("./live", () => ({ NativeYjs: class {} }));
import IgnisConnector from "./main.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
describe("FIFO persistence of local operation state", () => {
  it("does not allow an older asynchronous save to overwrite a newer queue", async () => {
    const plugin = new IgnisConnector();
    plugin.settings = { pendingWrites: [{ opId: "old-op" }] };
    const first = deferred();
    const saved = [];
    plugin.saveData = vi.fn(async (value) => {
      saved.push(JSON.parse(JSON.stringify(value)));
      if (saved.length === 1) await first.promise;
    });
    const one = plugin.persistSettings();
    plugin.settings.pendingWrites.push({ opId: "new-op" });
    const two = plugin.persistSettings();
    await Promise.resolve();
    await Promise.resolve();
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(saved[0].pendingWrites).toHaveLength(1);
    first.resolve();
    await Promise.all([one, two]);
    expect(saved[1].pendingWrites.map((x) => x.opId))
      .toEqual(["old-op", "new-op"]);
  });
  it("continues writing later snapshots after a storage failure", async () => {
    const plugin = new IgnisConnector();
    plugin.settings = { cursor: 1 };
    plugin.saveData = vi.fn()
      .mockRejectedValueOnce(new Error("disk temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const first = plugin.persistSettings();
    plugin.settings.cursor = 2;
    const second = plugin.persistSettings();
    await expect(first).rejects.toThrow(/disk/);
    await expect(second).resolves.toBeUndefined();
    expect(plugin.saveData).toHaveBeenNthCalledWith(2, { cursor: 2 });
  });
});
