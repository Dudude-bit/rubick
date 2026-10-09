import { readFileSync } from "node:fs";
import { describe, it, expect } from "vite-plus/test";
import { contrast, type Rgb } from "./color";
import {
  splitName,
  identHue,
  kindHue,
  crdWidthsKey,
  IDENT_HUES,
} from "./resource-identity";

describe("splitName", () => {
  it("splits a ReplicaSet hash and pod suffix", () => {
    expect(splitName("crash-demo-56588f6b8c-8bj9v")).toEqual({
      stem: "crash-demo",
      tail: "-56588f6b8c-8bj9v",
    });
  });

  it("splits a CronJob unix minute and its pod suffix", () => {
    expect(splitName("cron-demo-29765945-cl6m2")).toEqual({
      stem: "cron-demo",
      tail: "-29765945-cl6m2",
    });
    expect(splitName("cron-demo-29765945")).toEqual({
      stem: "cron-demo",
      tail: "-29765945",
    });
  });

  it("splits a StatefulSet ordinal", () => {
    expect(splitName("stateful-demo-0")).toEqual({
      stem: "stateful-demo",
      tail: "-0",
    });
  });

  it("splits a bare DaemonSet pod suffix", () => {
    expect(splitName("daemon-demo-lrslf")).toEqual({
      stem: "daemon-demo",
      tail: "-lrslf",
    });
  });

  // A ReplicaSet is named after its Deployment plus the pod-template hash,
  // with no pod suffix behind it. It is the name shown on a pod's "Controlled
  // by" row, so leaving it whole makes the one place the two names sit
  // together disagree about which part is generated.
  it.each([
    ["crash-demo-56588f6b8c", "crash-demo", "-56588f6b8c"],
    ["log-demo-596964f7d6", "log-demo", "-596964f7d6"],
    ["coredns-ccb96694c", "coredns", "-ccb96694c"],
  ])("splits the bare ReplicaSet hash in %s", (name, stem, tail) => {
    expect(splitName(name)).toEqual({ stem, tail });
  });

  // A name a human typed is not noise. Guessing wrong here is worse than
  // not guessing, so anything unrecognised comes back whole.
  it.each([
    "bad-image-demo",
    "metrics-server",
    "kube-dns",
    "local-path-provisioner",
    "coredns",
    "unschedulable-demo",
    // Long, vowel-free and alphabet-legal, but no digit — a pod-template
    // hash is a hex-ish digest and effectively always carries one. Requiring
    // that is what stops this branch from eating human words.
    "cert-manager-webhook",
    "prometheus-pushgateway",
  ])("leaves %s whole", (name) => {
    expect(splitName(name)).toEqual({ stem: name, tail: "" });
  });

  it("never returns an empty stem", () => {
    expect(splitName("-0").stem).not.toBe("");
    expect(splitName("29765945")).toEqual({ stem: "29765945", tail: "" });
  });

  // Every pod name in the k3d-k8s-gui-dev cluster, split by hand first: the
  // regex is only worth anything if it agrees with what a human reads as the
  // workload's name.
  it.each([
    ["coredns-ccb96694c-f92j4", "coredns", "-ccb96694c-f92j4"],
    ["helm-install-traefik-gcm7g", "helm-install-traefik", "-gcm7g"],
    ["helm-install-traefik-crd-lrphw", "helm-install-traefik-crd", "-lrphw"],
    ["job-demo-z8pj7", "job-demo", "-z8pj7"],
    [
      "local-path-provisioner-5cf85fd84d-wssb9",
      "local-path-provisioner",
      "-5cf85fd84d-wssb9",
    ],
    ["metrics-server-5985cbc9d7-qflmb", "metrics-server", "-5985cbc9d7-qflmb"],
    ["traefik-5d45fc8cc9-ndqn6", "traefik", "-5d45fc8cc9-ndqn6"],
    // klipper-lb builds the DaemonSet name from a hex digest, which is not
    // the generated alphabet. The pod suffix is, so only that comes off —
    // and the whole DaemonSet name stays readable, which is the right answer.
    ["svclb-traefik-7c3534f1-482mc", "svclb-traefik-7c3534f1", "-482mc"],
  ])("splits the live pod %s", (name, stem, tail) => {
    expect(splitName(name)).toEqual({ stem, tail });
  });

  // The generated alphabet has no vowels, so a word cannot be mistaken for a
  // pod suffix however long it is.
  it.each(["app-cache", "web-nginx", "db-redis", "api-proxy", "ui-admin"])(
    "leaves the human word in %s alone",
    (name) => {
      expect(splitName(name)).toEqual({ stem: name, tail: "" });
    }
  );
});

describe("identHue", () => {
  it("is deterministic", () => {
    expect(identHue("Pod", "a-1")).toBe(identHue("Pod", "a-1"));
  });

  it("separates two kinds that share a name", () => {
    expect(identHue("Pod", "cron-demo-29765945")).not.toBe(
      identHue("Job", "cron-demo-29765945")
    );
  });

  // Twenty-four near-identical names is the case the hash exists for, and the
  // case a weak one fails: an unavalanched FNV-1a puts this batch on seven
  // hues. Six would pass and still look like three colours in a column, so
  // the bar is set where a bad hash cannot clear it.
  it("spreads a realistic batch across at least ten hues", () => {
    const names = Array.from(
      { length: 24 },
      (_, i) => `cron-demo-297659${20 + i}-abc${i}`
    );
    const hues = new Set(names.map((n) => identHue("Pod", n)));
    expect(hues.size).toBeGreaterThanOrEqual(10);
  });

  // The names a real cluster produces, which is the case the hash exists for:
  // a column of one CronJob's pods must not read as one colour.
  it("spreads the live cluster's pods across at least ten hues", () => {
    const names = [
      "bad-image-demo",
      "crash-demo-56588f6b8c-8bj9v",
      "crash-demo-56588f6b8c-dlg8x",
      "cron-demo-29766085-gt7v2",
      "cron-demo-29766090-hglmx",
      "cron-demo-29766095-5r6hw",
      "daemon-demo-79h6m",
      "daemon-demo-lrslf",
      "job-demo-z8pj7",
      "log-demo-596964f7d6-54zt4",
      "log-demo-596964f7d6-dft2m",
      "stateful-demo-0",
      "unschedulable-demo",
      "coredns-ccb96694c-f92j4",
      "helm-install-traefik-crd-lrphw",
      "helm-install-traefik-gcm7g",
      "local-path-provisioner-5cf85fd84d-wssb9",
      "metrics-server-5985cbc9d7-qflmb",
      "svclb-traefik-7c3534f1-482mc",
      "svclb-traefik-7c3534f1-qz989",
      "traefik-5d45fc8cc9-ndqn6",
    ];
    const hues = new Set(names.map((n) => identHue("Pod", n)));
    expect(hues.size).toBeGreaterThanOrEqual(10);
  });

  it("returns a hue in range", () => {
    for (const n of ["a", "bb", "ccc-1", "d-56588f6b8c-8bj9v"]) {
      const h = identHue("Pod", n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("kindHue", () => {
  it("gives workload kinds one family and network kinds another", () => {
    expect(Math.abs(kindHue("Pod") - kindHue("Deployment"))).toBeLessThan(40);
    expect(Math.abs(kindHue("Pod") - kindHue("Service"))).toBeGreaterThan(40);
  });

  it("falls back for an unknown kind", () => {
    expect(kindHue("Frobnicator")).toBe(kindHue("Node"));
  });
});

describe("where a CRD list files its column widths", () => {
  /**
   * `certificates` is cert-manager's and Knative's alike, with different
   * printer columns behind the same word. Keyed on the plural alone, the
   * widths a reader dragged on one opened the other with columns sized for
   * a table it has never seen — and nothing about it looks broken, so
   * nobody reports it.
   */
  it("tells two kinds sharing a plural apart by their group", () => {
    expect(crdWidthsKey("certificates", "cert-manager.io")).not.toBe(
      crdWidthsKey("certificates", "networking.internal.knative.dev")
    );
  });

  /** The same list on two visits has to find what it stored last time. */
  it("gives one kind the same key every time", () => {
    expect(crdWidthsKey("certificates", "cert-manager.io")).toBe(
      crdWidthsKey("certificates", "cert-manager.io")
    );
  });
});

const css = readFileSync("src/ui/index.css", "utf8");
const THEMES = [
  ["light", css.slice(css.indexOf(":root {"), css.indexOf(".dark {"))],
  ["dark", css.slice(css.indexOf(".dark {"))],
] as const;

function token(block: string, role: string): number[] {
  const match = new RegExp(
    `${role}:\\s*([\\d.]+) ([\\d.]+)% ([\\d.]+)%(?:\\s*/\\s*([\\d.]+))?`
  ).exec(block);
  if (!match) throw new Error(`${role} is not an hsl triple`);
  return match.slice(1).filter(Boolean).map(Number);
}

function percent(block: string, role: string): number {
  const match = new RegExp(`${role}:\\s*([\\d.]+)%`).exec(block);
  if (!match) throw new Error(`${role} is not a percentage`);
  return Number(match[1]);
}

function rgb(h: number, s: number, l: number): Rgb {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

const over = (wash: number[], under: Rgb): Rgb => {
  const top = rgb(wash[0], wash[1], wash[2]);
  return under.map((v, i) => top[i] * wash[3] + v * (1 - wash[3])) as Rgb;
};

const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe("the identity palette beside the status colours", () => {
  /**
   * `web` hashed onto a pink-red and was read as broken beside real red
   * verdicts. Fails if any identity hue sits within 35 degrees of the hue
   * `--err`, `--warn` or `--ok` wears in either theme.
   */
  it.each(THEMES)("stays out of every status hue band in %s", (_n, block) => {
    for (const role of ["--err", "--warn", "--ok"]) {
      const status = token(block, role)[0];
      for (const hue of IDENT_HUES)
        expect(apart(hue, status), `${hue} vs ${role}`).toBeGreaterThan(35);
    }
  });

  /**
   * A name is drawn on the canvas, on an overlay, and on either one hovered
   * or selected. Fails if any identity colour drops below 4.5:1 on any of
   * them, which is how the blues and violets read on dark before.
   */
  it.each(THEMES)("reads at 4.5:1 on every surface in %s", (_n, block) => {
    const s = percent(block, "--ident-s");
    const l = percent(block, "--ident-l");
    const surfaces = ["--canvas", "--raise"].flatMap((role) => {
      const [h, sat, light] = token(block, role);
      const base = rgb(h, sat, light);
      return [
        base,
        over(token(block, "--hover"), base),
        over(token(block, "--sel"), base),
      ];
    });
    for (const hue of IDENT_HUES)
      for (const surface of surfaces)
        expect(contrast(rgb(hue, s, l), surface)).toBeGreaterThanOrEqual(4.5);
  });
});
