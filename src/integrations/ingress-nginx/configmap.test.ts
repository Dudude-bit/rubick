import { describe, expect, it } from "vitest";

import { GLOBAL_KEYS, readSetting, readSettings } from "./configmap";

describe("the global ConfigMap reader", () => {
  /**
   * The same floor annotations.test.ts holds over TABLE_SIZE. Without it a
   * table that quietly shrank to three keys would still pass every other
   * test here — each one names its own key, so none of them notices the
   * absence of the rest.
   */
  it("keeps saying something about the settings it claims to know", () => {
    expect(GLOBAL_KEYS).toBeGreaterThanOrEqual(20);
  });

  /**
   * The distinction the module exists to draw: a setting the ConfigMap owns
   * is what happens, a setting the annotation table also carries is what
   * happens unless an Ingress said otherwise. A reader chasing why one route
   * behaves unlike the rest needs to know which of the two they are looking
   * at.
   */
  it("marks a key only the ConfigMap has as final", () => {
    const reading = readSetting("server-tokens", "false");
    expect(reading.said).not.toBeNull();
    expect(reading.overridable).toBe(false);
  });

  it("marks a key an Ingress can also set as overridable", () => {
    const reading = readSetting("proxy-body-size", "50m");
    expect(reading.said).not.toBeNull();
    expect(reading.overridable).toBe(true);
  });

  /** A key nobody can decode is still shown, labelled, rather than dropped. */
  it("keeps a key it does not know instead of hiding it", () => {
    const reading = readSetting("some-future-nginx-key", "1");
    expect(reading.said).toBeNull();
    expect(reading.raw).toBe("notInTheTable");
    expect(reading.value).toBe("1");
  });

  /** Nobody arrives here chasing a request, so the order is lookup order. */
  it("lists settings alphabetically", () => {
    const readings = readSettings({
      "server-tokens": "false",
      "allow-snippet-annotations": "true",
      "proxy-body-size": "50m",
    });
    expect(readings.map((r) => r.key)).toEqual([
      "allow-snippet-annotations",
      "proxy-body-size",
      "server-tokens",
    ]);
  });
});
