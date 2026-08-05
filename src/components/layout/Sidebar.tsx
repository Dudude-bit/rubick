import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Box,
  Network,
  Database,
  FileText,
  Server,
  Activity,
  Package,
  Settings,
  ChevronDown,
  Puzzle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useEffect, useState } from "react";
import {
  ResourceType,
  getDisplayPlural,
  getResourceListUrl,
} from "@/lib/resource-registry";
import { useUpdaterStore } from "@/stores/updaterStore";

const navItems = [
  { icon: LayoutDashboard, label: "Overview", path: "/" },
  {
    icon: Box,
    label: "Workloads",
    path: "/workloads",
    children: [
      {
        label: getDisplayPlural(ResourceType.Pod),
        path: getResourceListUrl(ResourceType.Pod),
      },
      {
        label: getDisplayPlural(ResourceType.Deployment),
        path: getResourceListUrl(ResourceType.Deployment),
      },
      {
        label: getDisplayPlural(ResourceType.StatefulSet),
        path: getResourceListUrl(ResourceType.StatefulSet),
      },
      {
        label: getDisplayPlural(ResourceType.DaemonSet),
        path: getResourceListUrl(ResourceType.DaemonSet),
      },
      {
        label: getDisplayPlural(ResourceType.Job),
        path: getResourceListUrl(ResourceType.Job),
      },
      {
        label: getDisplayPlural(ResourceType.CronJob),
        path: getResourceListUrl(ResourceType.CronJob),
      },
    ],
  },
  {
    icon: Network,
    label: "Network",
    path: "/network",
    children: [
      {
        label: getDisplayPlural(ResourceType.Service),
        path: getResourceListUrl(ResourceType.Service),
      },
      {
        label: getDisplayPlural(ResourceType.Ingress),
        path: getResourceListUrl(ResourceType.Ingress),
      },
      {
        label: getDisplayPlural(ResourceType.Endpoints),
        path: getResourceListUrl(ResourceType.Endpoints),
      },
    ],
  },
  {
    icon: Database,
    label: "Storage",
    path: "/storage",
    children: [
      {
        label: getDisplayPlural(ResourceType.PersistentVolume),
        path: getResourceListUrl(ResourceType.PersistentVolume),
      },
      {
        label: getDisplayPlural(ResourceType.PersistentVolumeClaim),
        path: getResourceListUrl(ResourceType.PersistentVolumeClaim),
      },
      {
        label: getDisplayPlural(ResourceType.StorageClass),
        path: getResourceListUrl(ResourceType.StorageClass),
      },
    ],
  },
  {
    icon: FileText,
    label: "Configuration",
    path: "/configuration",
    children: [
      {
        label: getDisplayPlural(ResourceType.ConfigMap),
        path: getResourceListUrl(ResourceType.ConfigMap),
      },
      {
        label: getDisplayPlural(ResourceType.Secret),
        path: getResourceListUrl(ResourceType.Secret),
      },
      { label: "Builder", path: "/configuration/builder" },
    ],
  },
  {
    icon: Server,
    label: getDisplayPlural(ResourceType.Node),
    path: getResourceListUrl(ResourceType.Node),
  },
  {
    icon: Activity,
    label: getDisplayPlural(ResourceType.Event),
    path: getResourceListUrl(ResourceType.Event),
  },
  {
    icon: Puzzle,
    label: getDisplayPlural(ResourceType.CustomResourceDefinition),
    path: getResourceListUrl(ResourceType.CustomResourceDefinition),
  },
  { icon: Package, label: "Helm", path: "/helm" },
  { icon: Settings, label: "Settings", path: "/settings" },
];

export function Sidebar() {
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const location = useLocation();
  const updateAvailable = useUpdaterStore((state) => state.available);
  const { data: appInfo } = useQuery({
    queryKey: ["appInfo"],
    queryFn: commands.getAppInfo,
    staleTime: Infinity,
  });

  useEffect(() => {
    const activeParents = navItems
      .filter((item) => item.children)
      .filter((item) => {
        if (
          location.pathname === item.path ||
          location.pathname.startsWith(`${item.path}/`)
        ) {
          return true;
        }
        return item.children?.some(
          (child) =>
            location.pathname === child.path ||
            location.pathname.startsWith(`${child.path}/`)
        );
      })
      .map((item) => item.label);

    if (activeParents.length === 0) {
      return;
    }

    // Genuine union-of-user-intent-and-external-state pattern: the
    // user can collapse parents manually, but route navigation must
    // auto-expand the matching parent. Splitting into separate
    // userExpanded / autoExpanded sets would require a state model
    // refactor — left as a follow-up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedItems((prev) => {
      const next = new Set(prev);
      activeParents.forEach((label) => next.add(label));
      return Array.from(next);
    });
  }, [location.pathname]);

  const toggleExpanded = (label: string) => {
    setExpandedItems((prev) =>
      prev.includes(label)
        ? prev.filter((item) => item !== label)
        : [...prev, label]
    );
  };

  return (
    <aside className="flex w-52 flex-col border-r border-hair">
      {/* Logo */}
      <div className="flex h-11 items-center gap-2 px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
          <span className="text-lg font-bold text-primary-foreground">K8</span>
        </div>
        <span className="font-semibold">K8s GUI</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin py-2">
        {navItems.map((item) => (
          <div key={item.label}>
            {item.children ? (
              <>
                <button
                  onClick={() => toggleExpanded(item.label)}
                  className="flex w-full items-center gap-2 px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt"
                >
                  <item.icon className="h-3.5 w-3.5 text-fg-fnt" />
                  <span className="flex-1 text-left">{item.label}</span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      expandedItems.includes(item.label) && "rotate-180"
                    )}
                  />
                </button>
                {expandedItems.includes(item.label) && (
                  <div className="ml-4 border-l border-hair pl-4">
                    {item.children.map((child) => (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        className={({ isActive }) =>
                          cn(
                            "block rounded-[5px] px-2 py-1 text-xs text-fg-mid transition-colors hover:bg-hover",
                            isActive && "bg-sel font-medium text-fg"
                          )
                        }
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-[5px] px-2 py-1 text-xs text-fg-mid transition-colors hover:bg-hover",
                    isActive && "bg-sel font-medium text-fg"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <div className="relative">
                      <item.icon
                        className={cn(
                          "h-3.5 w-3.5 text-fg-fnt",
                          isActive && "text-info"
                        )}
                      />
                      {item.label === "Settings" && updateAvailable && (
                        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-err" />
                      )}
                    </div>
                    {item.label}
                  </>
                )}
              </NavLink>
            )}
          </div>
        ))}
      </nav>

      {/* Version */}
      <div className="border-t border-border p-4 text-xs text-muted-foreground">
        {appInfo?.version ?? "..."}
      </div>
    </aside>
  );
}
