import { useState } from "react";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { useHydrated } from "../lib/use-hydrated";

// The app's rule, copied from src/lib/certificates.ts: an exact name, or one
// label under a wildcard. The browser's rule, not a looser one.
function covers(dnsNames: string[], host: string): boolean {
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

const CERTS = [
  {
    id: "shop-tls",
    name: "shop-tls",
    origin:
      "Certificate shop-tls from the specimens: Ready, 90 days, renews 30 days out",
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
  if (covers([...dnsNames], host)) {
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

export function Certificate() {
  const interactive = useHydrated();
  const [certId, setCertId] =
    useState<(typeof CERTS)[number]["id"]>("shop-tls");
  const [host, setHost] = useState(HOSTS[2]!);
  const cert = CERTS.find((c) => c.id === certId)!;
  const ok = covers([...cert.dnsNames], host);

  return (
    <Section id="certificate" eyebrow="cert-manager">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Valid. For somebody else.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          A certificate that is Ready, valid for another sixty days and mounted
          on the Ingress answers one question: is it good. The question that
          matters is whether it is good for this host. Rubick checks every host
          an Ingress serves against the names the certificate carries, with the
          browser's rule: an exact name, or one label under a wildcard. Pick a
          host.
        </p>
      </Reveal>
      <Reveal className="mt-12 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60">
        <div className="grid gap-6 p-6 md:grid-cols-2">
          <div className="min-w-0">
            <p className="font-mono text-xs text-neutral-500">certificate</p>
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
                    className={`min-h-11 rounded-md border px-3 py-2 font-mono text-sm ${FOCUS} ${certId === c.id ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`}
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
                    className={`min-h-11 rounded-md border px-3 py-2 font-mono text-sm ${FOCUS} ${host === h ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`}
                  >
                    {h}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 font-mono text-sm text-neutral-100">{host}</p>
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
                  The Secret is mounted, the dates are fine, every other screen
                  draws it healthy, and the browser refuses the connection.
                  Rubick's row says: mounted but not covering.
                </p>
              )}
            </div>
          </div>
        </div>
      </Reveal>
      <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-400">
        Matching a host is a statement about names, not about the connection:
        whether TLS actually terminates there is a separate check.
      </p>
    </Section>
  );
}
