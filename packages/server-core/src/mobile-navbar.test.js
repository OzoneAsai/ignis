// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountMobileNavbarAction } from "./mobile-navbar.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("integrated Obsidian mobile navbar action", () => {
  it("waits for the navbar, inserts one action, survives navbar replacement, and cleans up", async () => {
    document.body.replaceChildren();
    const action = document.createElement("div");
    action.className = "mobile-navbar-action ignis-navbar-action";
    const stop = mountMobileNavbarAction(action);
    expect(action.isConnected).toBe(false);
    const first = document.createElement("nav");
    first.className = "mobile-navbar";
    first.innerHTML = '<div class="mobile-navbar-actions"><button>Back</button></div>';
    document.body.append(first);
    await tick();
    expect(action.parentElement).toBe(first.querySelector(".mobile-navbar-actions"));
    expect(first.querySelector("button").textContent).toBe("Back");
    const next = first.cloneNode(true);
    next.querySelector(".ignis-navbar-action").remove();
    first.replaceWith(next);
    await tick();
    expect(action.parentElement).toBe(next.querySelector(".mobile-navbar-actions"));
    expect(next.querySelectorAll(".ignis-navbar-action")).toHaveLength(1);
    stop();
    expect(action.isConnected).toBe(false);
    next.remove();
  });

  it("relocates the ONE action into Obsidian's edit toolbar when a note is focused", async () => {
    document.body.replaceChildren();
    document.body.className = "is-phone is-mobile";
    const navbar = document.createElement("nav");
    navbar.className = "mobile-navbar";
    navbar.innerHTML = '<div class="mobile-navbar-actions"><button>Back</button></div>';
    document.body.append(navbar);
    const action = document.createElement("div");
    action.className = "mobile-navbar-action ignis-navbar-action";
    action.innerHTML = '<button class="ignis-navbar-trigger">Ignis</button>';
    const stop = mountMobileNavbarAction(action);
    const navActions = navbar.querySelector(".mobile-navbar-actions");
    expect(action.parentElement).toBe(navActions);
    expect(action.classList.contains("mobile-navbar-action")).toBe(true);

    const editingToolbar = document.createElement("div");
    editingToolbar.className = "mobile-toolbar";
    editingToolbar.innerHTML = '<div class="mobile-toolbar-options-list">' +
      '<div class="mobile-toolbar-option">Bold</div></div>';
    navbar.remove(); // Obsidian removes the navigation on editor focus.
    document.body.classList.add("mod-toolbar-open");
    document.body.append(editingToolbar);
    await tick();
    const editActions = editingToolbar.querySelector(".mobile-toolbar-options-list");
    expect(action.parentElement).toBe(editActions);
    expect(editActions.firstElementChild).toBe(action);
    expect(action.classList.contains("mobile-toolbar-option")).toBe(true);
    expect(action.classList.contains("mobile-navbar-action")).toBe(false);
    expect(editActions.children).toHaveLength(2);

    document.body.classList.remove("mod-toolbar-open");
    editingToolbar.remove();
    document.body.append(navbar);
    await tick();
    expect(action.parentElement).toBe(navActions);
    expect(action.classList.contains("mobile-navbar-action")).toBe(true);
    expect(document.querySelectorAll(".ignis-navbar-action")).toHaveLength(1);

    stop();
    expect(action.isConnected).toBe(false);
    navbar.remove();
    document.body.className = "";
  });

  it("survives replacement of the editing toolbar while keeping other buttons intact", async () => {
    document.body.replaceChildren();
    const edit = document.createElement("div");
    edit.className = "mobile-toolbar";
    edit.innerHTML = '<div class="mobile-toolbar-options-list"><button>Undo</button></div>';
    document.body.append(edit);
    const action = document.createElement("div");
    action.className = "mobile-navbar-action ignis-navbar-action";
    const stop = mountMobileNavbarAction(action);
    expect(action.parentElement).toBe(edit.querySelector(".mobile-toolbar-options-list"));
    const next = document.createElement("div");
    next.className = "mobile-toolbar";
    next.innerHTML = '<div class="mobile-toolbar-options-list"><button>Redo</button></div>';
    edit.replaceWith(next);
    await tick();
    expect(action.parentElement).toBe(next.querySelector(".mobile-toolbar-options-list"));
    expect(next.querySelector("button").textContent).toBe("Redo");
    stop();
    next.remove();
  });
});
