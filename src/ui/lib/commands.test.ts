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
  listPods: vi.fn(
    () =>
      new Promise((_, reject) =>
        backend.release.push(() =>
          reject("CREDENTIALS_EXPIRED: the token expired at 12:00")
        )
      )
  ),
}));

import { commands, CONFIG_WRITES } from "./commands";
import { credentialsRestored, readExpiredCredentials } from "./credentials";
import { followConnections } from "./refusals";

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

describe("a 401 the window is no longer owed", () => {
  /** A read sent on connection 7 that answers 401 once the window is on `now`. */
  async function expiresOn(now: number) {
    let connection = 7;
    followConnections(() => connection);
    credentialsRestored();
    backend.release.length = 0;
    const asked = commands.listPods(null);
    await settle();
    connection = now;
    backend.release[0]!();
    await expect(asked).rejects.toThrow(/CREDENTIALS_EXPIRED/);
    const said = readExpiredCredentials()?.reason ?? null;
    credentialsRestored();
    followConnections(() => 0);
    return said;
  }

  /**
   * The window left an expired cluster for one it still held, and a poll
   * already in flight to the old one came back 401 and put the healthy
   * cluster behind "credentials refused". Fails if a 401 counts against a
   * connection other than the one its request was sent on.
   */
  it("does not count against the connection the window moved to", async () => {
    expect(await expiresOn(8)).toBeNull();
  });

  /** Fails if the guard above stops a 401 on the window's own connection too. */
  it("still counts on the connection it was sent on", async () => {
    expect(await expiresOn(7)).toBe("the token expired at 12:00");
  });
});
