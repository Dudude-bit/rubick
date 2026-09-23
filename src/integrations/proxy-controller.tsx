import type { ReactNode } from "react";

import { ResourceRef } from "@/components/resources/ResourceRef";
import { Section, SectionHeader } from "@/components/ui/section";
import type { IngressClassSummary } from "@/generated/types";
import { sayWords, type Saying } from "@/i18n/say";
import { useT } from "@/i18n/useT";
import type { ControllerWorkload } from "./ingress";

/**
 * A proxy's own tab: the workload that runs it, the IngressClasses it
 * answers for, and the flags it was started with. Traefik's and nginx's
 * were the same screen written twice.
 */
export function ProxyControllerTab({
  controller,
  classes,
  words,
  classesNote,
}: {
  controller:
    | {
        workload: ControllerWorkload | null;
        args: string[];
        problem: Saying | null;
      }
    | undefined;
  classes: IngressClassSummary[];
  words: {
    reading: string;
    title: string;
    description: string;
    claimsNoClass: string;
  };
  /** Under the class list: what the controller was told to look for. */
  classesNote?: ReactNode;
}) {
  const t = useT();
  if (!controller) {
    return <p className="text-xs text-fg-fnt">{words.reading}</p>;
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader title={words.title} description={words.description} />
        {controller.workload ? (
          <div className="flex flex-col gap-1 text-[11.5px] text-fg-mut">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <ResourceRef
                kind={controller.workload.kind}
                name={controller.workload.name}
                namespace={controller.workload.namespace}
                showKind={false}
              />
              <span className="text-fg-fnt">
                {t("count", "ofTotalReady", {
                  n: controller.workload.ready,
                  total: controller.workload.desired,
                })}{" "}
                · {controller.workload.namespace}
              </span>
            </span>
            {controller.workload.image && (
              <span className="font-mono text-[11px] text-fg-fnt">
                {controller.workload.image}
              </span>
            )}
            {controller.problem && (
              <p className="text-[11px] text-warn">
                {sayWords(controller.problem, t)}
              </p>
            )}
          </div>
        ) : (
          <p className="max-w-[64ch] text-[11px] text-fg-fnt">
            {controller.problem && sayWords(controller.problem, t)}
          </p>
        )}
      </Section>

      <Section>
        <SectionHeader
          title={t("empty", "classesItClaims")}
          count={classes.length}
          description={t("empty", "classesItClaimsDescription")}
        />
        {classes.length === 0 ? (
          <p className="text-[11px] text-warn">{words.claimsNoClass}</p>
        ) : (
          <div className="flex flex-col">
            {classes.map((entry) => (
              <div
                key={entry.name}
                className="flex items-baseline gap-2 border-b border-hair py-1.5 text-[11.5px]"
              >
                <span className="font-mono text-fg-mid">{entry.name}</span>
                {entry.isDefault && (
                  <span className="text-[11px] text-fg-fnt">
                    {t("empty", "clustersDefault")}
                  </span>
                )}
                <span className="ml-auto font-mono text-[11px] text-fg-fnt">
                  {entry.controller}
                </span>
              </div>
            ))}
          </div>
        )}
        {classesNote}
      </Section>

      {controller.args.length > 0 && (
        <Section>
          <SectionHeader
            title={t("empty", "staticConfiguration")}
            count={controller.args.length}
            description={t("empty", "staticConfigurationDescription")}
          />
          <div className="flex flex-col gap-0.5 font-mono text-[11px] text-fg-mut">
            {controller.args.map((arg, index) => (
              <span key={index} className="select-text break-all">
                {arg}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
