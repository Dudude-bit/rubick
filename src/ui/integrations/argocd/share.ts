import { Box, Layers } from "lucide-react";

import type { CustomResourceInfo } from "@/generated/types";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { toPlural } from "@/lib/resource-registry";
import { conditionsOf } from "../kit";
import type { ControllerInfo } from "./data";

/** The one condition that turns an ApplicationSet row red. */
export function failingConditionOf(set: CustomResourceInfo) {
  return conditionsOf(set).find(
    (condition) =>
      condition.type === "ErrorOccurred" && condition.status === "True"
  );
}

export function appSetsSection(
  sets: CustomResourceInfo[] | undefined,
  error: unknown,
  t: T
): PlacedSection | null {
  const shell = {
    id: "argocd-appsets",
    order: ORDER.own,
    title: t("nav", "applicationSets"),
    icon: iconSvg(Layers),
  };
  if (!sets)
    return {
      ...shell,
      count: null,
      unread: error ? errorToShow(error) : t("share", "stillReading"),
      body: { type: "findings", items: [] },
    };
  const found = sets.flatMap((set) => {
    const failing = failingConditionOf(set);
    if (!failing) return [];
    return [
      {
        title: set.name,
        detail: failing.message ?? null,
        role: "err" as const,
        ref: refOf({
          kind: "ApplicationSet",
          name: set.name,
          namespace: set.namespace,
        }),
      },
    ];
  });
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}

export function controllerSection(
  controller: ControllerInfo | undefined,
  t: T
): PlacedSection | null {
  const shell = {
    id: "argocd-controller",
    order: ORDER.own,
    title: t("nav", "argoOwnWorkloads"),
    icon: iconSvg(Box),
  };
  if (!controller)
    return {
      ...shell,
      count: null,
      unread: t("share", "stillReading"),
      body: { type: "findings", items: [] },
    };
  const found = [
    ...controller.components
      .filter((component) => component.ready < component.desired)
      .map((component) => ({
        title: component.name,
        detail: t("count", "ofTotalReady", {
          n: component.ready,
          total: component.desired,
        }),
        role: "err" as const,
        ref: refOf({
          kind: component.kind,
          name: component.name,
          namespace: component.namespace,
        }),
      })),
    ...controller.unread.map(({ kind, failure }) => ({
      title: t("empty", "argoWorkloadsUnread", { kinds: toPlural(kind) }),
      detail: sayWords(failure, t),
      role: "warn" as const,
    })),
  ];
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}
