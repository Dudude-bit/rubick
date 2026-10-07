import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vite-plus/test";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

import { GLOBAL_KEYS, readSetting, readSettings } from "./configmap";

const ru: T = (section, key, values) => translate("ru", section, key, values);

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
    const reading = readSetting("server-tokens", "false", t);
    expect(reading.said).not.toBeNull();
    expect(reading.overridable).toBe(false);
  });

  it("marks a key an Ingress can also set as overridable", () => {
    const reading = readSetting("proxy-body-size", "50m", t);
    expect(reading.said).not.toBeNull();
    expect(reading.overridable).toBe(true);
  });

  /**
   * "Ответы несут версию nginx" and "Error log несёт всё" read as English
   * carried over word for word. Fails if either sentence goes back to a verb
   * of carrying, or an error level loses what it says is logged.
   */
  it("says in plain Russian what the version header and each error level show", () => {
    expect(readSetting("server-tokens", "true", ru).said).toBe(
      "В заголовке Server каждого ответа указана версия nginx."
    );
    const levels = Object.fromEntries(
      ["debug", "info", "notice", "warn", "error"].map((level) => [
        level,
        readSetting("error-log-level", level, ru).said,
      ])
    );
    expect(levels).toEqual({
      debug: "В error log пишется всё, включая подробности по каждому запросу.",
      info: "В error log пишутся информационные сообщения и всё, что серьёзнее.",
      notice: "В error log пишутся уведомления и всё, что серьёзнее.",
      warn: "В error log пишутся предупреждения и всё, что серьёзнее.",
      error: "В error log пишутся только ошибки.",
    });
  });

  /** A key nobody can decode is still shown, labelled, rather than dropped. */
  it("keeps a key it does not know instead of hiding it", () => {
    const reading = readSetting("some-future-nginx-key", "1", t);
    expect(reading.said).toBeNull();
    expect(reading.raw).toBe("notInTheTable");
    expect(reading.value).toBe("1");
  });

  /** Nobody arrives here chasing a request, so the order is lookup order. */
  it("lists settings alphabetically", () => {
    const readings = readSettings(
      {
        "server-tokens": "false",
        "allow-snippet-annotations": "true",
        "proxy-body-size": "50m",
      },
      t
    );
    expect(readings.map((r) => r.key)).toEqual([
      "allow-snippet-annotations",
      "proxy-body-size",
      "server-tokens",
    ]);
  });
});
