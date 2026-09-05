import type { ReactNode } from "react";
import { CommandLine } from "../components/command-line";
import { Reveal } from "../components/motion/reveal";
import { Trace } from "../components/motion/trace";
import { TruthSwap } from "../components/motion/truth-swap";
import { Section } from "../components/section";
import { WindowFrame } from "../components/window-frame";
import { IMG, LINKS } from "../lib/site";

const LIES: {
  lie: string;
  bust: string;
  evidence: ReactNode;
  img: (typeof IMG)[keyof typeof IMG];
  alt: string;
}[] = [
  {
    lie: '"Running", says the pod.',
    bust: "The container inside has crashed fourteen times. .status.phase does not care, and most dashboards read .status.phase. Rubick derives status the way kubectl does, so a crashloop looks like a crashloop. And when you open the logs they open on the container that failed, at its previous run, not the fresh copy that has not died yet.",
    evidence: (
      <TruthSwap
        reported="Running"
        observed="CrashLoopBackOff · log opened on the run that failed"
      />
    ),
    img: IMG.logs,
    alt: "Logs opened on the failing init container's previous run",
  },
  {
    lie: '"All green", says the Service.',
    bust: "Healthy pods, matching selector, one mistyped port name. The Service publishes nothing, and it will stay green all week. Rubick reads the endpoints the cluster actually publishes, not the ones you meant to publish.",
    evidence: (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 font-mono text-sm text-neutral-300">
          <span className="size-1.5 rounded-full bg-green-400" />
          selector matches 3/3 pods
        </p>
        <TruthSwap
          reported="3 endpoints"
          observed='published with no port · "htp" matches no container'
        />
      </div>
    ),
    img: IMG.connections,
    alt: "Connections tab grouping a workload's network paths by question",
  },
  {
    lie: '"No route to host", says nobody at all.',
    bust: "Somewhere between the Ingress and the pod, the request dies quietly. Rubick draws the whole chain on the workload's own page, and where the path stops it names the reason: a backend that does not exist, a selector matching nothing, pods running but not ready.",
    evidence: (
      <Trace
        steps={[
          { label: "Ingress" },
          { label: "rule /api" },
          { label: "Service api-v2", tone: "bad" },
        ]}
        linkTone="bad"
        reason="Service api-v2 does not exist. Nothing past it was looked at."
      />
    ),
    img: IMG.chain,
    alt: "A traffic chain that stops, with the reason named at the broken link",
  },
];

export function Lies() {
  return (
    <Section eyebrow="Status: fine, apparently">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Three lies you have already been told this week.
        </h2>
      </Reveal>
      <div className="mt-16 flex flex-col gap-24 md:gap-32">
        {LIES.map((l, i) => (
          <div
            key={l.lie}
            id={`lie-${i + 1}`}
            className="scroll-mt-24 items-center gap-12 md:grid md:grid-cols-2"
          >
            <Reveal className={i % 2 === 1 ? "md:order-last" : undefined}>
              <p className="text-accent font-mono text-sm">LIE #{i + 1}</p>
              <p className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
                {l.lie}
              </p>
              <p className="mt-4 text-neutral-400">{l.bust}</p>
              <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
                {l.evidence}
              </div>
            </Reveal>
            <Reveal settle delay={70} className="mt-8 md:mt-0">
              <WindowFrame img={l.img} alt={l.alt} />
            </Reveal>
          </div>
        ))}
      </div>
      <Reveal className="mt-24 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 md:mt-32 md:p-8">
        <p className="text-accent font-mono text-sm tracking-widest uppercase">
          Reproduce them
        </p>
        <h3 className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
          Three objects, one throwaway cluster.
        </h3>
        <p className="mt-4 max-w-2xl text-neutral-400">
          kind or k3d is enough, and no ingress controller is needed: the lies
          live in the objects, not in the traffic. You get a pod whose phase is
          Running while its only container crashes on every start, a Service
          whose three pods are Ready and which publishes no port, and an Ingress
          rule pointing at a Service that does not exist.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <CommandLine command={`kubectl apply -f ${LINKS.lies}`} />
          <CommandLine command="kubectl -n rubick-lies get pod,svc,endpointslice,ingress" />
          <CommandLine command={`kubectl delete -f ${LINKS.lies}`} />
        </div>
        <p className="mt-6 font-mono text-sm text-neutral-500">
          # kubectl reads the same objects Rubick does, so it is not fooled
          either. The dashboards that are fooled read .status.phase, or the
          selector, or the rule, and stop there.
        </p>
      </Reveal>
    </Section>
  );
}
