import type { CSSProperties } from "react";
import { DownloadButtons } from "../components/download-buttons";
import { Claims } from "../components/motion/claims";
import { TruthSwap } from "../components/motion/truth-swap";
import { WindowFrame } from "../components/window-frame";
import { IMG } from "../lib/site";
import { usePointerParallax } from "../lib/use-pointer-parallax";

const rise = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

export function Hero() {
  const ref = usePointerParallax<HTMLElement>();
  return (
    <section ref={ref} className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[linear-gradient(90deg,rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(70%_60%_at_50%_30%,#000_30%,transparent_100%)]"
      />
      <div className="relative mx-auto w-full max-w-6xl px-6 pt-20 pb-24 md:pt-28">
        <div className="relative">
          <Claims />
          <div data-rise style={rise(0)}>
            <p className="text-accent mb-6 font-mono text-sm tracking-widest uppercase">
              A desktop Kubernetes client
            </p>
            <h1 className="max-w-4xl font-display text-5xl font-bold tracking-tight md:text-7xl">
              Your cluster is lying to you.
            </h1>
          </div>
          <p
            data-rise
            style={rise(70)}
            className="mt-6 max-w-2xl text-lg text-neutral-400 md:text-xl"
          >
            A crashlooping pod says Running. A Service with a mistyped port
            draws green and publishes nothing. Rubick reads what the cluster
            actually does, and tells you that instead.
          </p>
          <div data-rise style={rise(105)} className="mt-6 lg:hidden">
            <TruthSwap reported="Running" observed="CrashLoopBackOff" />
          </div>
          <div data-rise style={rise(140)} className="mt-10">
            <DownloadButtons />
          </div>
          <p
            data-rise
            style={rise(210)}
            className="mt-6 font-mono text-sm text-neutral-500"
          >
            Free. GPLv3. No account. No telemetry.
          </p>
        </div>
        <div data-rise style={rise(280)} className="mt-16">
          <div className="hero-shot">
            <WindowFrame
              img={IMG.hero}
              alt="Rubick showing a workload page with live status, usage history and the traffic chain"
              eager
            />
          </div>
        </div>
      </div>
    </section>
  );
}
