import { describe, expect, it, vi } from "vite-plus/test";

const backend = vi.hoisted(() => ({
  saved: [] as string[],
  release: [] as Array<() => void>,
}));

vi.mock("@/generated/commands", () => ({
  saveClusterPreferences: vi.fn(
    (_last: string | null, context: string | null, namespace: string | null) =>
      new Promise<void>((resolve, reject) => {
        backend.saved.push(`${context}/${namespace}`);
        backend.release.push(() =>
          namespace === "refused" ? reject(new Error("disk full")) : resolve()
        );
      })
  ),
  listNamespaces: vi.fn(async () => []),
}));

import { commands, CONFIG_WRITES } from "./commands";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("config writes", () => {
  /** Fails if a second namespace switch can reach config.toml before the first, so the older one is saved last. */
  it("reach the backend in the order they were asked for, each after the last answered", async () => {
    backend.saved.length = 0;
    backend.release.length = 0;
    const first = commands.saveClusterPreferences(null, "prod", "shop", null);
    const second = commands.saveClusterPreferences(null, "prod", "web", null);
    await settle();
    expect(backend.saved).toEqual(["prod/shop"]);

    backend.release[0]!();
    await first;
    await settle();
    expect(backend.saved).toEqual(["prod/shop", "prod/web"]);
    backend.release[1]!();
    await second;
  });

  /** Fails if one save that failed holds every save after it forever. */
  it("go on after one fails", async () => {
    backend.saved.length = 0;
    backend.release.length = 0;
    const refused = commands.saveClusterPreferences(
      null,
      "prod",
      "refused",
      null
    );
    const next = commands.saveClusterPreferences(null, "prod", "web", null);
    await settle();
    backend.release[0]!();
    await expect(refused).rejects.toThrow("disk full");
    await settle();
    expect(backend.saved).toEqual(["prod/refused", "prod/web"]);
    backend.release[1]!();
    await next;
  });

  /** Fails if a read of the cluster waits behind a save of the config. */
  it("hold nothing that is not a config write", async () => {
    backend.release.length = 0;
    const slow = commands.saveClusterPreferences(null, "prod", "shop", null);
    await expect(commands.listNamespaces()).resolves.toEqual([]);
    await settle();
    backend.release[0]!();
    await slow;
  });

  /** Fails if a name in the list is not a command, so the write it meant is left unordered. */
  it("name commands the backend has", async () => {
    const generated = await vi.importActual<Record<string, unknown>>(
      "@/generated/commands"
    );
    for (const name of CONFIG_WRITES)
      expect(typeof generated[name], name).toBe("function");
  });
});
