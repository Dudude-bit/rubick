import { Section } from "../components/section";
import { WindowFrame } from "../components/window-frame";
import { IMG } from "../lib/site";

export function Warns() {
  return (
    <Section>
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-accent mb-6 font-mono text-sm tracking-widest uppercase">
          Before you act
        </p>
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-5xl">
          It warns before it obeys.
        </h2>
        <p className="mt-6 text-neutral-400">
          Scale, Restart, Delete and Edit YAML tell you who will undo your
          change and how fast. An autoscaler, in seconds. Argo CD or Flux, in
          minutes. Then it does what you asked anyway, because a hand edit
          during an incident is legitimate and you are an adult.
        </p>
      </div>
      <div className="mx-auto mt-12 max-w-3xl">
        <WindowFrame
          src={IMG.scale}
          alt="Scaling a deployment an autoscaler owns, with the warning naming who will undo it"
        />
      </div>
    </Section>
  );
}
