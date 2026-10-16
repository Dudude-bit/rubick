import { Container } from "lucide-react";

import { iconSvg } from "@/lib/icon-svg";
import { parseImageRef } from "@/lib/image-ref";
import type { ReportContainer } from "@/lib/report";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { DeploymentContainerInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";

export interface TemplateContainers {
  containers: readonly DeploymentContainerInfo[];
  initContainers: readonly DeploymentContainerInfo[];
}

function templateContainerRow(
  container: DeploymentContainerInfo,
  init: boolean
): ReportContainer {
  const image = parseImageRef(container.image);
  return {
    name: container.name,
    repository: image
      ? [image.registry, image.repository].filter(Boolean).join("/")
      : container.image,
    tag: image ? (image.tag ?? image.digest?.slice(0, 19) ?? null) : null,
    // Declared, not observed: a template has no runtime state to colour.
    state: "",
    role: "neutral",
    notes: [],
    init,
  };
}

/**
 * A workload's declared containers, image repository and tag only, what
 * the spec says, not what a pod happens to be running right now.
 */
export function templateContainersSection(
  template: TemplateContainers,
  t: T
): PlacedSection {
  const containers = [
    ...template.initContainers.map((c) => templateContainerRow(c, true)),
    ...template.containers.map((c) => templateContainerRow(c, false)),
  ];
  return {
    id: "containers",
    order: ORDER.own,
    title: t("columns", "containers"),
    icon: iconSvg(Container),
    count: containers.length,
    body: { type: "containers", containers },
  };
}
