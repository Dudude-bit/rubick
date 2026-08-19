/**
 * The names other people's packaging depends on.
 *
 * The AUR package rubick-kubernetes-bin fetches
 * `Rubick_${pkgver}_amd64.deb` from every release, and five icons by raw
 * GitHub URL. Both are recorded in prose — a comment in `release.yml` and
 * `src-tauri/icons/README.md` — and prose sits where nobody renaming the
 * product will pass: `productName` is in `tauri.conf.json`, which cannot
 * hold a comment at all. So the contract is a test instead, and it fails
 * in the pull request rather than in somebody's next `pacman -Syu`.
 *
 * Breaking it on purpose is fine. Tell the package's maintainer, then
 * change this test in the same commit that changes the name.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const config = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")
) as { productName: string; bundle: { targets: string[] } };

describe("what the AUR package downloads", () => {
  /**
   * Would break if the product were renamed: the asset becomes
   * `Something_4.3.0_amd64.deb` and the package's fetch 404s on the next
   * release, with nothing in this repo having looked wrong.
   */
  it("still builds a .deb called Rubick", () => {
    expect(config.productName).toBe("Rubick");
    expect(config.bundle.targets).toContain("deb");
  });

  /**
   * Would break if an icon were renamed or moved: the package pins a
   * commit and bumps it per release, so the failure lands on the
   * maintainer, one release later, far from whoever tidied the folder.
   */
  it("still keeps the five icons it fetches by raw URL", () => {
    for (const icon of [
      "256x256.png",
      "128x128.png",
      "64x64.png",
      "32x32.png",
      "icon.svg",
    ]) {
      expect(
        existsSync(resolve(root, "src-tauri/icons", icon)),
        `src-tauri/icons/${icon} is fetched by rubick-kubernetes-bin`
      ).toBe(true);
    }
  });
});
