// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installMobileToolbarViewport } from "./mobile-toolbar-viewport.js";

const property = "--ignis-mobile-visual-bottom";
const cleanups = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.documentElement.style.removeProperty(property);
});

function fakeWindow({ visibleHeight, offsetTop = 0, layoutHeight = 844 }) {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: visibleHeight, offsetTop });
  const win = new EventTarget();
  win.visualViewport = viewport;
  win.innerHeight = layoutHeight;
  const doc = { documentElement: { clientHeight: layoutHeight,
    style: document.documentElement.style } };
  cleanups.push(installMobileToolbarViewport(win, doc));
  return { viewport, win, doc };
}

describe("Obsidian mobile toolbar in iPhone Safari", () => {
  it("keeps the original viewport bottom when no keyboard is present", () => {
    fakeWindow({ visibleHeight: 844 });
    expect(document.documentElement.style.getPropertyValue(property)).toBe("844px");
  });

  it("moves the toolbar above a Safari software keyboard as viewport shrinks", () => {
    const { viewport } = fakeWindow({ visibleHeight: 844 });
    viewport.height = 494;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue(property)).toBe("494px");
    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue(property)).toBe("844px");
  });

  it("accounts for visual viewport offsets during browser chrome and pinch changes", () => {
    const { viewport } = fakeWindow({ visibleHeight: 510, offsetTop: 64 });
    expect(document.documentElement.style.getPropertyValue(property)).toBe("574px");
    viewport.offsetTop = 124;
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue(property)).toBe("634px");
    viewport.height = 800;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue(property)).toBe("844px");
  });

  it("cleans up observers and the custom property", () => {
    const { viewport } = fakeWindow({ visibleHeight: 500 });
    cleanups.pop()();
    expect(document.documentElement.style.getPropertyValue(property)).toBe("");
    viewport.height = 320;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue(property)).toBe("");
  });

  it("does nothing when VisualViewport is unsupported", () => {
    const stop = installMobileToolbarViewport(new EventTarget(), document);
    stop();
    expect(document.documentElement.style.getPropertyValue(property)).toBe("");
  });
});
