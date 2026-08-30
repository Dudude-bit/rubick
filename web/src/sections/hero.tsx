import { DownloadButtons } from "../components/download-buttons";
import { WindowFrame } from "../components/window-frame";
import { IMG } from "../lib/site";

export function Hero() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-20 pb-24 md:pt-28">
      <p className="text-accent mb-6 font-mono text-sm tracking-widest uppercase">
        A desktop Kubernetes client
      </p>
      <h1 className="max-w-4xl font-display text-5xl font-bold tracking-tight md:text-7xl">
        Your cluster is lying to you.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-neutral-400 md:text-xl">
        A crashlooping pod says Running. A Service with a mistyped port draws
        green and publishes nothing. Rubick reads what the cluster actually
        does, and tells you that instead.
      </p>
      <div className="mt-10">
        <DownloadButtons />
      </div>
      <p className="mt-6 font-mono text-sm text-neutral-500">
        Free. GPLv3. No account. No telemetry.
      </p>
      <div className="mt-16">
        <WindowFrame
          img={IMG.hero}
          alt="Rubick showing a workload page with live status, usage history and the traffic chain"
          eager
        />
      </div>
    </section>
  );
}
