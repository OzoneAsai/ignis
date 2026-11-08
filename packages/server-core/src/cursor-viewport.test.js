// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { observeCursorViewport } from "./cursor-viewport.ts";

describe("document-anchored editor cursor viewport lifecycle", () => {
  it("creates a real containing block for theme-static CodeMirror and restores styles", () => {
    const host = document.createElement("div");
    const scroller = document.createElement("div");
    host.append(scroller);
    document.body.append(host);
    host.style.position = "static";
    const repaint = vi.fn();
    const stop = observeCursorViewport(host, scroller, repaint);
    expect(host.style.position).toBe("relative");
    stop();
    expect(host.style.getPropertyValue("position")).toBe("static");
    host.remove();
  });

  it("recovers when a theme dynamically resets the positioning context", () => {
    const host = document.createElement("div");
    const scroll = document.createElement("div");
    host.style.position = "relative";
    host.append(scroll);
    document.body.append(host);
    const repaint = vi.fn();
    const stop = observeCursorViewport(host, scroll, repaint);
    host.style.position = "static";
    scroll.dispatchEvent(new Event("scroll"));
    expect(host.style.position).toBe("relative");
    stop();
    expect(host.style.position).toBe("relative");
    host.remove();
  });

  it("repaints for editor scroll, scroll parents and window scroll", () => {
    const parent = document.createElement("div");
    const host = document.createElement("div");
    const scroll = document.createElement("div");
    host.append(scroll);
    parent.append(host);
    document.body.append(parent);
    const repaint = vi.fn();
    const stop = observeCursorViewport(host, scroll, repaint);
    scroll.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(repaint).toHaveBeenCalled();
    const count = repaint.mock.calls.length;
    parent.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(repaint.mock.calls.length).toBeGreaterThan(count);
    const unrelated = document.createElement("div");
    document.body.append(unrelated);
    const previous = repaint.mock.calls.length;
    unrelated.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(repaint.mock.calls.length).toBe(previous);
    stop();
    const after = repaint.mock.calls.length;
    parent.dispatchEvent(new Event("scroll", { bubbles: false }));
    scroll.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(repaint.mock.calls.length).toBe(after);
    parent.remove();
    unrelated.remove();
  });

  it("responds to iPhone visual viewport scroll and resize, then detaches", () => {
    const visual = new EventTarget();
    Object.defineProperty(window, "visualViewport", {
      configurable: true, value: visual,
    });
    const host = document.createElement("div");
    const scroll = document.createElement("div");
    host.append(scroll);
    document.body.append(host);
    const repaint = vi.fn();
    const reposition = vi.fn();
    const stop = observeCursorViewport(host, scroll, repaint, reposition);
    visual.dispatchEvent(new Event("scroll"));
    visual.dispatchEvent(new Event("resize"));
    expect(reposition).toHaveBeenCalledTimes(2);
    expect(repaint).not.toHaveBeenCalled();
    stop();
    visual.dispatchEvent(new Event("scroll"));
    expect(reposition).toHaveBeenCalledTimes(2);
    delete window.visualViewport;
    host.remove();
  });
});
