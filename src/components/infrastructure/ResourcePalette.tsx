import { ResourceKind } from "@/features/infrastructure/types";
import { ResourceType } from "@/lib/resource-registry";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

interface ResourcePaletteProps {
  onAdd: (kind: ResourceKind) => void;
  onTemplate: (templateId: string) => void;
  onPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    kind: ResourceKind
  ) => void;
}

const RESOURCE_ITEMS: Array<{
  kind: ResourceKind;
  description: keyof typeof en.action;
}> = [
  { kind: ResourceType.Pod, description: "paletteDescPod" },
  { kind: ResourceType.Deployment, description: "paletteDescDeployment" },
  { kind: ResourceType.Service, description: "paletteDescService" },
  { kind: ResourceType.Ingress, description: "paletteDescIngress" },
  { kind: ResourceType.ConfigMap, description: "paletteDescConfigMap" },
  { kind: ResourceType.Secret, description: "paletteDescSecret" },
];

const TEMPLATE_ITEMS: Array<{
  id: string;
  label: keyof typeof en.action;
  description: string;
}> = [
  {
    id: "web-service",
    label: "templateWebService",
    description: "Deployment + Service + Ingress",
  },
  {
    id: "config-backed-app",
    label: "templateConfigBackedApp",
    description: "ConfigMap + Deployment + Service",
  },
];

export function ResourcePalette({
  onAdd,
  onTemplate,
  onPointerDown,
}: ResourcePaletteProps) {
  const t = useT();

  return (
    // A palette is a list, not a panel. One vertical hairline separates it
    // from the canvas; each item is a row that lights up on hover like any
    // other row in the app.
    <div className="flex flex-col gap-4 border-r border-hair pr-3">
      <div>
        <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
          {t("action", "paletteResources")}
        </h3>
        <div className="border-t border-hair">
          {RESOURCE_ITEMS.map((item) => (
            <div
              key={item.kind}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => onPointerDown(event, item.kind)}
              onClick={() => onAdd(item.kind)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onAdd(item.kind);
                }
              }}
              className="w-full cursor-grab touch-none select-none rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info active:cursor-grabbing"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-fg">{item.kind}</span>
                <span className="text-[11px] text-fg-fnt">
                  {t("action", "paletteDrag")}
                </span>
              </div>
              <div className="text-[11px] text-fg-mut">
                {t("action", item.description)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
          {t("action", "paletteTemplates")}
        </h3>
        <div className="border-t border-hair">
          {TEMPLATE_ITEMS.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className="h-auto w-full flex-col items-start gap-0 px-1.5 py-1 text-left"
              onClick={() => onTemplate(item.id)}
            >
              <span className="font-medium text-fg">
                {t("action", item.label)}
              </span>
              <span className="text-[11px] font-normal text-fg-mut">
                {item.description}
              </span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
