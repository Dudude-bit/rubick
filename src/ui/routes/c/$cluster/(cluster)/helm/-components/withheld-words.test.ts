import { describe, expect, it } from "vite-plus/test";

import type { ReleaseWithheld, WithheldDocument } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  manifestWithheldWords,
  resourcesNotListedWords,
  valuesWithheldWords,
} from "./withheld-words";

const en: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

const secret: WithheldDocument = {
  position: 2,
  source: "keys/templates/secret.yaml",
  kind: "Secret",
  name: "web-key",
  what: { says: "keys", keys: ["tls.key", "id_rsa"] },
};
const flow: WithheldDocument = {
  position: 3,
  source: null,
  kind: "ConfigMap",
  name: "nginx",
  what: { says: "rewritten", keys: ["server.key"] },
};
const broken: WithheldDocument = {
  position: 4,
  source: "keys/templates/broken.yaml",
  kind: null,
  name: null,
  what: { says: "unread" },
};
const settings: WithheldDocument = {
  position: 5,
  source: null,
  kind: null,
  name: null,
  what: { says: "rewritten", keys: ["signing.material"] },
};

const withheld: ReleaseWithheld = {
  values: ["tls.privateKey", "servers[0].key"],
  manifest: [secret, flow, broken, settings],
  notes: false,
};
const nothing: ReleaseWithheld = { values: [], manifest: [], notes: false };

describe("what a Helm release's tabs say the app withheld", () => {
  /**
   * The Manifest tab drew the app's placeholder as though the chart had
   * rendered it. Fails if a document is not named by its object and its
   * template, its keys are not listed, or the reader is not told the release
   * still holds the value.
   */
  it("names each document, its keys, and whose the placeholder is", () => {
    const [keys, rewritten, unread, unnamed] = manifestWithheldWords(
      withheld,
      en
    );

    expect(keys).toBe(
      "Withheld in Secret web-key (keys/templates/secret.yaml): tls.key, id_rsa. The release is untouched: the app never shows a private key, and the placeholder there is the app's, for the screen."
    );
    expect(rewritten).toMatch(
      /^Withheld in ConfigMap nginx: server\.key\. .* the app wrote this document out again, so its layout is not the chart's\.$/
    );
    expect(unread).toMatch(
      /^Withheld whole: document 4 \(keys\/templates\/broken\.yaml\)\. .* does not read as YAML here, so the app cannot tell whether it holds a private key/
    );
    expect(unnamed).toMatch(/^Withheld in document 5: signing\.material\./);
    expect(manifestWithheldWords(nothing, en)).toEqual([]);
  });

  /** Fails if any of the three sentences is English in the Russian UI. */
  it("says the same in Russian", () => {
    const [keys, rewritten, unread, unnamed] = manifestWithheldWords(
      withheld,
      ru
    );

    expect(keys).toMatch(
      /^Secret web-key \(keys\/templates\/secret\.yaml\): скрыто tls\.key, id_rsa\. Релиз не тронут/
    );
    expect(rewritten).toMatch(/записало этот документ заново/);
    expect(unread).toMatch(
      /^Документ 4 \(keys\/templates\/broken\.yaml\): содержимое скрыто целиком/
    );
    expect(unnamed).toMatch(/^Документ 5: скрыто signing\.material\./);
    expect(valuesWithheldWords(withheld, ru)).toEqual([
      "Скрыто: tls.privateKey, servers[0].key. Релиз не тронут: приложение не показывает закрытые ключи, и заглушку на их месте оно поставило само, только для экрана.",
    ]);
  });

  /**
   * The Values tab drew `privateKey: <withheld: …>` as a value of the
   * release. Fails if the paths are not listed, or a line is drawn for a
   * release with nothing withheld.
   */
  it("lists where in the values, and says nothing where nothing was withheld", () => {
    expect(valuesWithheldWords(withheld, en)).toEqual([
      "Withheld: tls.privateKey, servers[0].key. The release is untouched: the app never shows a private key, and the placeholder there is the app's, for the screen.",
    ]);
    expect(valuesWithheldWords(nothing, en)).toEqual([]);
  });

  /**
   * Only a document withheld whole is an object missing from the Resources
   * tab: one with a key blanked is still listed.
   */
  it("says of each document withheld whole that the list lacks it", () => {
    expect(resourcesNotListedWords(withheld, en)).toEqual([
      "Not listed: document 4 (keys/templates/broken.yaml). It does not read as YAML here, so the app cannot say what it installs.",
    ]);
    expect(resourcesNotListedWords(withheld, ru)[0]).toMatch(
      /^Документ 4 \(keys\/templates\/broken\.yaml\): в списке нет\./
    );
  });
});
