import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { Plural } from "./catalogue";
import { ru } from "./ru";

const CARRYING = /(?<![\p{L}])нес(?:ёт|ут|ёшь|у|ли|ла|ло)(?![\p{L}])/iu;

function strings(): Array<[string, string]> {
  return Object.entries(ru).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, string | Plural>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string"
          ? [[`${section}.${key}`, value]]
          : Object.entries(value).map(([form, text]) => [
              `${section}.${key}.${form}`,
              String(text),
            ])
    )
  );
}

describe("Russian written as a person says it", () => {
  /**
   * Lena read "Ответы несут версию nginx", "Error log несёт всё" and "какой
   * Gateway несёт app-tls": English "carries" with a Russian verb on it, for
   * a label, a log level and a set of listeners. Fails when any string says
   * something is carried again.
   */
  it("never says an object, a log or a header carries something", () => {
    const offenders = strings()
      .filter(([, text]) => CARRYING.test(text))
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  /** The hint under Ports not exposed names what is compared, in words a Russian reader has. */
  it("says a slice's ports are matched to the Service's by name", () => {
    expect(translate("ru", "empty", "portsNotExposedHint")).toBe(
      "В срезе порты привязаны к портам Service по имени. Имена этих портов не совпадают ни с одним из объявленных в срезе, поэтому к ним ничего не маршрутизируется."
    );
  });
});
