import { Section } from "../components/section";
import { WindowFrame } from "../components/window-frame";
import { IMG } from "../lib/site";

const LIES = [
  {
    lie: '"Running", says the pod.',
    bust: "The container inside has crashed fourteen times. .status.phase does not care, and most dashboards read .status.phase. Rubick derives status the way kubectl does, so a crashloop looks like a crashloop. And when you open the logs they open on the container that failed, at its previous run, not the fresh copy that has not died yet.",
    src: IMG.logs,
    alt: "Logs opened on the failing init container's previous run",
  },
  {
    lie: '"All green", says the Service.',
    bust: "Healthy pods, matching selector, one mistyped port name. The Service publishes nothing, and it will stay green all week. Rubick reads the endpoints the cluster actually publishes, not the ones you meant to publish.",
    src: IMG.connections,
    alt: "Connections tab grouping a workload's network paths by question",
  },
  {
    lie: '"No route to host", says nobody at all.',
    bust: "Somewhere between the Ingress and the pod, the request dies quietly. Rubick draws the whole chain on the workload's own page, and where the path stops it names the reason: a backend that does not exist, a selector matching nothing, pods running but not ready.",
    src: IMG.chain,
    alt: "A traffic chain that stops, with the reason named at the broken link",
  },
];

export function Lies() {
  return (
    <Section eyebrow="Status: fine, apparently">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        Three lies you have already been told this week.
      </h2>
      <div className="mt-16 flex flex-col gap-24 md:gap-32">
        {LIES.map((l, i) => (
          <div
            key={l.lie}
            className="items-center gap-12 md:grid md:grid-cols-2"
          >
            <div className={i % 2 === 1 ? "md:order-last" : undefined}>
              <p className="text-accent font-mono text-sm">LIE #{i + 1}</p>
              <p className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
                {l.lie}
              </p>
              <p className="mt-4 text-neutral-400">{l.bust}</p>
            </div>
            <div className="mt-8 md:mt-0">
              <WindowFrame src={l.src} alt={l.alt} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
