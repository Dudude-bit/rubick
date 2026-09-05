import { useState } from "react";
import {
  LuBadgeCheck,
  LuFlag,
  LuListChecks,
  LuScrollText,
  LuShieldCheck,
  LuStamp,
} from "react-icons/lu";
import { Reveal } from "./motion/reveal";
import { CORE_KINDS, Peek, type KindStyle, type Subject } from "./peek";
import { Section } from "./section";
import { Footer } from "../sections/footer";
import { Nav } from "../sections/nav";
import { useHydrated } from "../lib/use-hydrated";

const CM = "#4f8ef7";

const KINDS: Record<string, KindStyle> = {
  ...CORE_KINDS,
  Certificate: { Icon: LuShieldCheck, color: CM },
  CertificateRequest: { Icon: LuScrollText, color: CM },
  Order: { Icon: LuListChecks, color: CM },
  Challenge: { Icon: LuFlag, color: CM },
  ClusterIssuer: { Icon: LuStamp, color: CM },
  Issuer: { Icon: LuBadgeCheck, color: CM },
};

// The app's rule, copied from src/lib/certificates.ts: an exact name, or one
// label under a wildcard. The browser's rule, not a looser one.
function covers(dnsNames: readonly string[], host: string): boolean {
  const wanted = host.replace(/\.$/, "").toLowerCase();
  return dnsNames.some((name) => {
    const given = name.replace(/\.$/, "").toLowerCase();
    if (given.startsWith("*.")) {
      const suffix = given.slice(1);
      if (!wanted.endsWith(suffix)) return false;
      const label = wanted.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".");
    }
    return given === wanted;
  });
}

// Read from the cert-manager specimens in test-manifests/k8s-gui-all.yaml
// on a k3d cluster with cert-manager 1.16.3 and Pebble, 2026-09-05 04:25 UTC.
const SUBJECTS: Subject[] = [
  {
    kind: "Certificate",
    name: "shop-tls",
    ns: "k8s-gui-test",
    facts: "90 days · renews 30 days before the end · CA-issued",
    status: { label: "Ready", tone: "ok" },
    details: [
      ["Message", "Certificate is up to date and has not expired"],
      ["Not before", "2026-09-05 04:25 UTC"],
      ["Not after", "2026-12-04 04:25 UTC"],
      ["Renews", "2026-11-04 04:25 UTC"],
      ["dnsNames", "shop.k8s-gui.test, www.shop.k8s-gui.test"],
      ["Private key", "ECDSA, never shown"],
    ],
    groups: [
      {
        title: "Issued by",
        rows: [
          {
            kind: "ClusterIssuer",
            name: "k8s-gui-ca",
            note: "CA, signs with the root below",
            tone: "ok",
          },
        ],
      },
      {
        title: "Issues into",
        rows: [
          {
            kind: "Secret",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "kubernetes.io/tls",
          },
        ],
      },
      {
        title: "Serving",
        note: "the hosts this certificate is mounted for, and whether it names them",
        rows: [
          {
            kind: "Ingress",
            name: "shop",
            ns: "k8s-gui-test",
            note: "shop.k8s-gui.test · covers",
            tone: "ok",
          },
        ],
      },
      {
        title: "Made by, and makes",
        rows: [
          {
            kind: "CertificateRequest",
            name: "shop-tls-1",
            ns: "k8s-gui-test",
            note: "Ready",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Certificate",
    name: "checkout-tls",
    ns: "k8s-gui-test",
    facts: "10 days · told to renew one hour before the end",
    status: { label: "certificate running out", tone: "warn" },
    details: [
      ["Message", "Certificate is up to date and has not expired"],
      ["Not after", "2026-09-15 04:25 UTC"],
      ["Renews", "2026-09-15 03:25 UTC, one hour before it expires"],
      ["dnsNames", "checkout.k8s-gui.test"],
      [
        "Rubick says",
        "inside the window a reader is supposed to act in; a renewal that fails at 03:25 has no second attempt before 04:25",
      ],
    ],
    groups: [
      {
        title: "Issued by",
        rows: [
          { kind: "ClusterIssuer", name: "k8s-gui-ca", note: "", tone: "ok" },
        ],
      },
      {
        title: "Issues into",
        rows: [
          {
            kind: "Secret",
            name: "checkout-tls",
            ns: "k8s-gui-test",
            note: "kubernetes.io/tls",
          },
        ],
      },
      {
        title: "Serving",
        rows: [
          {
            kind: "Ingress",
            name: "checkout",
            ns: "k8s-gui-test",
            note: "checkout.k8s-gui.test · covers",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Certificate",
    name: "promo-tls",
    ns: "k8s-gui-test",
    facts:
      "ACME, HTTP-01 · issued by a local Pebble server that can never reach this host",
    status: { label: "not Ready", tone: "bad" },
    details: [
      ["Message", "Issuing certificate as Secret does not exist"],
      ["dnsNames", "promo.k8s-gui.test"],
      [
        "Rubick says",
        "the issuance chain, walked down to the object that holds the sentence worth reading",
      ],
    ],
    groups: [
      {
        title: "Issuance chain",
        note: "Certificate, CertificateRequest, Order, Challenge, ordered by trouble",
        rows: [
          {
            kind: "CertificateRequest",
            name: "promo-tls-1",
            ns: "k8s-gui-test",
            note: "not Ready",
            tone: "warn",
          },
          {
            kind: "Order",
            name: "promo-tls-1-2490078012",
            ns: "k8s-gui-test",
            note: "pending",
            tone: "warn",
          },
          {
            kind: "Challenge",
            name: "promo-tls-1-2490078012-3714865164",
            ns: "k8s-gui-test",
            note: "pending, self check failing",
            tone: "bad",
          },
        ],
      },
      {
        title: "Issued by",
        rows: [
          {
            kind: "Issuer",
            name: "pebble-acme",
            ns: "k8s-gui-test",
            note: "ACME",
          },
        ],
      },
      {
        title: "Issues into",
        rows: [
          {
            kind: "Secret",
            name: "promo-tls",
            ns: "k8s-gui-test",
            note: "does not exist yet",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "CertificateRequest",
    name: "shop-tls-1",
    ns: "k8s-gui-test",
    facts: "the first and only request · signed by the CA issuer at once",
    status: { label: "Ready", tone: "ok" },
    groups: [
      {
        title: "Made by",
        rows: [
          {
            kind: "Certificate",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "made by",
            tone: "ok",
          },
        ],
      },
      {
        title: "Issued by",
        rows: [
          { kind: "ClusterIssuer", name: "k8s-gui-ca", note: "", tone: "ok" },
        ],
      },
    ],
  },
  {
    kind: "CertificateRequest",
    name: "checkout-tls-1",
    ns: "k8s-gui-test",
    facts: "the first and only request · signed by the CA issuer at once",
    status: { label: "Ready", tone: "ok" },
    groups: [
      {
        title: "Made by",
        rows: [
          {
            kind: "Certificate",
            name: "checkout-tls",
            ns: "k8s-gui-test",
            note: "made by",
            tone: "ok",
          },
        ],
      },
      {
        title: "Issued by",
        rows: [
          { kind: "ClusterIssuer", name: "k8s-gui-ca", note: "", tone: "ok" },
        ],
      },
    ],
  },
  {
    kind: "CertificateRequest",
    name: "promo-tls-1",
    ns: "k8s-gui-test",
    facts: "the first request for promo-tls",
    status: { label: "not Ready", tone: "warn" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [
          {
            kind: "Certificate",
            name: "promo-tls",
            ns: "k8s-gui-test",
            note: "made by",
            tone: "bad",
          },
          {
            kind: "Order",
            name: "promo-tls-1-2490078012",
            ns: "k8s-gui-test",
            note: "pending",
            tone: "warn",
          },
        ],
      },
    ],
  },
  {
    kind: "Order",
    name: "promo-tls-1-2490078012",
    ns: "k8s-gui-test",
    facts: "ACME order · state pending",
    status: { label: "pending", tone: "warn" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [
          {
            kind: "CertificateRequest",
            name: "promo-tls-1",
            ns: "k8s-gui-test",
            note: "made by",
          },
          {
            kind: "Challenge",
            name: "promo-tls-1-2490078012-3714865164",
            ns: "k8s-gui-test",
            note: "HTTP-01, pending",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "Challenge",
    name: "promo-tls-1-2490078012-3714865164",
    ns: "k8s-gui-test",
    facts:
      "HTTP-01 · promo.k8s-gui.test · the sentence worth reading, as the controller wrote it",
    status: { label: "pending", tone: "bad" },
    details: [
      [
        "Reason",
        "Waiting for HTTP-01 challenge propagation: failed to perform self check GET request 'http://promo.k8s-gui.test/.well-known/acme-challenge/MTsr…': dial tcp: lookup promo.k8s-gui.test on 10.43.0.10:53: no such host",
      ],
      [
        "Rubick says",
        "the host does not resolve inside the cluster, so the solver can never confirm its own answer; nothing upstream of this object can be fixed to change it",
      ],
    ],
    groups: [
      {
        title: "Made by",
        rows: [
          {
            kind: "Order",
            name: "promo-tls-1-2490078012",
            ns: "k8s-gui-test",
            note: "",
          },
        ],
      },
    ],
  },
  {
    kind: "ClusterIssuer",
    name: "k8s-gui-ca",
    facts: "CA issuer · signs with Secret k8s-gui-root-ca in cert-manager",
    status: { label: "Ready", tone: "ok" },
    groups: [
      {
        title: "Signs with",
        rows: [
          {
            kind: "Certificate",
            name: "k8s-gui-root-ca",
            ns: "cert-manager",
            note: "the root, self-signed, valid to 2036",
            tone: "ok",
          },
        ],
      },
      {
        title: "Issued",
        rows: [
          {
            kind: "Certificate",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "Ready",
            tone: "ok",
          },
          {
            kind: "Certificate",
            name: "checkout-tls",
            ns: "k8s-gui-test",
            note: "running out",
            tone: "warn",
          },
        ],
      },
    ],
  },
  {
    kind: "Certificate",
    name: "k8s-gui-root-ca",
    ns: "cert-manager",
    facts: "isCA · ECDSA P-256 · 10 years",
    status: { label: "Ready", tone: "ok" },
    details: [
      ["Not after", "2036-09-02 04:24 UTC"],
      ["Renews", "2033-05-04 12:24 UTC"],
      ["Common name", "k8s-gui test root"],
    ],
    groups: [
      {
        title: "Issued by",
        rows: [
          {
            kind: "ClusterIssuer",
            name: "k8s-gui-selfsigned",
            note: "self-signed",
            tone: "ok",
          },
        ],
      },
      {
        title: "Used by",
        rows: [
          {
            kind: "ClusterIssuer",
            name: "k8s-gui-ca",
            note: "signs with this root",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "ClusterIssuer",
    name: "k8s-gui-selfsigned",
    facts: "selfSigned · the start of the chain",
    status: { label: "Ready", tone: "ok" },
    groups: [
      {
        title: "Issued",
        rows: [
          {
            kind: "Certificate",
            name: "k8s-gui-root-ca",
            ns: "cert-manager",
            note: "the root",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Issuer",
    name: "pebble-acme",
    ns: "k8s-gui-test",
    facts:
      "ACME against Pebble, a local ACME server · HTTP-01 · no real CA is ever contacted",
    groups: [
      {
        title: "Issued",
        rows: [
          {
            kind: "Certificate",
            name: "promo-tls",
            ns: "k8s-gui-test",
            note: "not Ready",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "Secret",
    name: "shop-tls",
    ns: "k8s-gui-test",
    facts: "kubernetes.io/tls · tls.crt, tls.key · values never shown",
    groups: [
      {
        title: "Made by",
        rows: [
          {
            kind: "Certificate",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "Ready",
            tone: "ok",
          },
        ],
      },
      {
        title: "Used by",
        rows: [
          {
            kind: "Ingress",
            name: "shop",
            ns: "k8s-gui-test",
            note: "spec.tls, shop.k8s-gui.test",
          },
        ],
      },
    ],
  },
  {
    kind: "Secret",
    name: "checkout-tls",
    ns: "k8s-gui-test",
    facts: "kubernetes.io/tls · tls.crt, tls.key · values never shown",
    groups: [
      {
        title: "Made by",
        rows: [
          {
            kind: "Certificate",
            name: "checkout-tls",
            ns: "k8s-gui-test",
            note: "running out",
            tone: "warn",
          },
        ],
      },
      {
        title: "Used by",
        rows: [
          {
            kind: "Ingress",
            name: "checkout",
            ns: "k8s-gui-test",
            note: "spec.tls, checkout.k8s-gui.test",
          },
        ],
      },
    ],
  },
  {
    kind: "Ingress",
    name: "shop",
    ns: "k8s-gui-test",
    facts: "host shop.k8s-gui.test · TLS from shop-tls · class traefik",
    groups: [
      {
        title: "TLS certificate",
        rows: [
          {
            kind: "Certificate",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "serves TLS for shop.k8s-gui.test",
            tone: "ok",
          },
        ],
      },
      {
        title: "Needs to run",
        rows: [
          {
            kind: "Secret",
            name: "shop-tls",
            ns: "k8s-gui-test",
            note: "mounted for TLS",
          },
        ],
      },
    ],
  },
  {
    kind: "Ingress",
    name: "checkout",
    ns: "k8s-gui-test",
    facts: "host checkout.k8s-gui.test · TLS from checkout-tls · class traefik",
    groups: [
      {
        title: "TLS certificate",
        rows: [
          {
            kind: "Certificate",
            name: "checkout-tls",
            ns: "k8s-gui-test",
            note: "serves TLS for checkout.k8s-gui.test, running out",
            tone: "warn",
          },
        ],
      },
    ],
  },
];

const CERTS = [
  {
    id: "shop-tls",
    name: "shop-tls",
    origin: "the specimen above: Ready, 90 days, renews 30 days out",
    dnsNames: ["shop.k8s-gui.test", "www.shop.k8s-gui.test"],
  },
  {
    id: "wildcard",
    name: "*.k8s-gui.test",
    origin:
      "not in the specimens; here to show the wildcard rule the way browsers apply it",
    dnsNames: ["*.k8s-gui.test"],
  },
] as const;

const HOSTS = [
  "shop.k8s-gui.test",
  "www.shop.k8s-gui.test",
  "api.shop.k8s-gui.test",
  "checkout.k8s-gui.test",
];

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

function why(dnsNames: readonly string[], host: string) {
  if (covers(dnsNames, host)) {
    const exact = dnsNames.find((n) => n.toLowerCase() === host.toLowerCase());
    return exact
      ? `${host} is named on the certificate.`
      : `${host} is one label under ${dnsNames.find((n) => n.startsWith("*."))}.`;
  }
  const wild = dnsNames.find((n) => n.startsWith("*."));
  if (wild && host.endsWith(wild.slice(1))) {
    return `${host} is two labels under ${wild}; a wildcard covers one.`;
  }
  return `The certificate names ${dnsNames.join(" and ")}; ${host} is neither.`;
}

function chipClass(active: boolean) {
  return `min-h-11 rounded-md border px-3 py-2 font-mono text-sm ${FOCUS} ${active ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`;
}

export function CertificatesPage() {
  const interactive = useHydrated();
  const [certId, setCertId] =
    useState<(typeof CERTS)[number]["id"]>("shop-tls");
  const [host, setHost] = useState(HOSTS[2]!);
  const cert = CERTS.find((c) => c.id === certId)!;
  const ok = covers(cert.dnsNames, host);

  return (
    <>
      <Nav />
      <main>
        <Section eyebrow="cert-manager">
          <Reveal>
            <h1 className="max-w-4xl font-display text-4xl font-bold tracking-tight md:text-6xl">
              Valid. For somebody else.
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-neutral-400">
              A certificate answers one question on its own: is it good. The
              questions that matter are whether it is good for this host, who
              signed it, when it renews, and where the chain stopped when it did
              not. Four certificates from the repo's specimens, read live with
              cert-manager installed. Every row is a page; click through.
            </p>
          </Reveal>
          <Peek
            subjects={SUBJECTS}
            kinds={KINDS}
            root="Certificate/k8s-gui-test/shop-tls"
            className="mt-12 max-w-3xl"
          />
        </Section>

        <Section eyebrow="Covers, or does not">
          <Reveal>
            <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
              Good for this host?
            </h2>
            <p className="mt-6 max-w-2xl text-neutral-400">
              Rubick checks every host an Ingress serves against the names the
              certificate carries, with the browser's rule: an exact name, or
              one label under a wildcard. Pick a certificate and a host.
            </p>
          </Reveal>
          <Reveal className="mt-12 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60">
            <div className="grid gap-6 p-6 md:grid-cols-2">
              <div className="min-w-0">
                <p className="font-mono text-xs text-neutral-500">
                  certificate
                </p>
                {interactive ? (
                  <div
                    role="group"
                    aria-label="Certificate"
                    className="mt-2 flex flex-wrap gap-2"
                  >
                    {CERTS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={certId === c.id}
                        onClick={() => setCertId(c.id)}
                        className={chipClass(certId === c.id)}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-sm text-neutral-100">
                    {cert.name}
                  </p>
                )}
                <p className="mt-3 text-sm text-neutral-400">{cert.origin}.</p>
                <dl className="mt-4 font-mono text-[13px]">
                  <dt className="text-neutral-500">dnsNames</dt>
                  {cert.dnsNames.map((n) => (
                    <dd key={n} className="text-neutral-200">
                      {n}
                    </dd>
                  ))}
                </dl>
              </div>
              <div className="min-w-0">
                <p className="font-mono text-xs text-neutral-500">
                  host on the Ingress
                </p>
                {interactive ? (
                  <div
                    role="group"
                    aria-label="Host"
                    className="mt-2 flex flex-wrap gap-2"
                  >
                    {HOSTS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        aria-pressed={host === h}
                        onClick={() => setHost(h)}
                        className={chipClass(host === h)}
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-sm text-neutral-100">
                    {host}
                  </p>
                )}
                <div
                  key={`${certId}/${host}`}
                  aria-live="polite"
                  className="quiz-answer mt-5 rounded-lg border border-neutral-800 p-4"
                >
                  <span
                    className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-sm ${ok ? "border-green-400/60 text-green-300" : "border-red-400/70 text-red-300"}`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${ok ? "bg-green-400" : "bg-red-400"}`}
                    />
                    {ok ? "Covers" : "Not covered"}
                  </span>
                  <p className="mt-3 text-sm text-neutral-300">
                    {why(cert.dnsNames, host)}
                  </p>
                  {ok ? null : (
                    <p className="mt-2 text-sm text-neutral-400">
                      The Secret is mounted, the dates are fine, every other
                      screen draws it healthy, and the browser refuses the
                      connection. Rubick's row says: mounted but not covering.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Reveal>
          <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-400">
            Matching a host is a statement about names, not about the
            connection: whether TLS actually terminates there is a separate
            check. The specimens need cert-manager installed, so they are not
            part of lies.yaml.
          </p>
        </Section>
      </main>
      <Footer />
    </>
  );
}
