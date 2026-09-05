import { CommandLine } from "./command-line";
import { Reveal } from "./motion/reveal";
import { LINKS } from "../lib/site";

export function ReproducePanel({ className = "" }: { className?: string }) {
  return (
    <Reveal
      className={`rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 md:p-8 ${className}`}
    >
      <p className="text-accent font-mono text-sm tracking-widest uppercase">
        Reproduce them
      </p>
      <h3 className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
        Three objects, one throwaway cluster.
      </h3>
      <p className="mt-4 max-w-2xl text-neutral-400">
        kind or k3d is enough, and no ingress controller is needed: the lies
        live in the objects, not in the traffic. You get a pod whose phase is
        Running while its only container crashes on every start, a Service whose
        three pods are Ready and which publishes no port, and an Ingress rule
        pointing at a Service that does not exist.
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
  );
}
