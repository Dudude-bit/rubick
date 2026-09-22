// Vitest global setup file. Loaded by vitest.config.ts via `setupFiles`.
//
// Runs before every test file, under jsdom or under node — the file's
// extension decides which (vitest.config.ts). Stubs the @tauri-apps/api
// surface so modules that import `invoke`, `listen`, `getCurrentWindow`, etc.
// don't blow up where the Tauri runtime isn't present, and, under jsdom only,
// adds the DOM matchers and unmounts what a test rendered.

import { vi } from "vitest";

if (typeof window !== "undefined") {
  await import("./test-setup-dom");
} else {
  // jsdom always reports en-US; node reports the machine's locale, and the
  // app's language follows navigator.language. Pinned, so a suite that
  // passes on CI passes on a laptop set to Russian.
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperty(globalThis.navigator, "languages", {
    configurable: true,
    value: ["en-US"],
  });
}

// Default jsdom doesn't ship matchMedia or ResizeObserver — Radix and various
// UI libraries call into them at mount.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}

// Node 26 defines its own global `localStorage`, which shadows jsdom's and
// stays undefined unless the process was started with `--localstorage-file`.
// Any store wrapped in zustand's `persist` reads it at import time and throws.
// The setup file runs before the test module graph is loaded, so replacing it
// here is early enough for every persisted store.
if (!globalThis.localStorage?.setItem) {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: (index: number) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
}

// Tauri API mocks — every call returns a resolved promise / no-op listener.
// Individual tests override per-method via `vi.mocked(...)` if they care.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  once: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: vi.fn(async () => () => {}),
    emit: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }),
}));
