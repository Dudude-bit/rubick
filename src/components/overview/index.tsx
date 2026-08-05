import { Link } from "react-router-dom";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { MetricValue } from "@/components/ui/metric-value";

// Shared types

export type StatBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "error";

export type StatBadgeConfig = {
  label: string;
  value: number;
  variant?: StatBadgeVariant;
  icon?: React.ElementType;
  hideWhenZero?: boolean;
};

export type ResourceStatCardData = {
  id: string;
  title: string;
  icon: React.ElementType;
  value: number;
  badges?: StatBadgeConfig[];
  description?: string;
  href?: string;
};

export type TopPodMetric = {
  name: string;
  namespace: string;
  value: number;
};

export type QuickActionTileProps = {
  icon: React.ElementType;
  label: string;
  description: string;
  href?: string;
  onClick?: () => void;
};

// Components

import { cn } from "@/lib/utils";

export type OverviewHeaderProps = {
  title: string;
  subtitle: string;
};

export function OverviewHeader({ title, subtitle }: OverviewHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-fg-mut">{subtitle}</p>
      </div>
    </div>
  );
}

export function ResourceStatCard({
  title,
  icon: Icon,
  value,
  badges,
  description,
  href,
}: ResourceStatCardData) {
  const visibleBadges =
    badges?.filter((badge) => !badge.hideWhenZero || badge.value > 0) ?? [];

  const stat = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </span>
        <Icon className="h-4 w-4 text-fg-fnt" />
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {visibleBadges.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {visibleBadges.map((badge) => {
            const BadgeIcon = badge.icon;
            return (
              <Badge
                key={badge.label}
                variant={badge.variant ?? "secondary"}
                className="gap-1"
              >
                {BadgeIcon && <BadgeIcon className="h-3 w-3" />}
                {badge.value} {badge.label}
              </Badge>
            );
          })}
        </div>
      )}
      {description && <p className="text-xs text-fg-mut">{description}</p>}
    </>
  );

  if (!href) {
    return <Section className="p-2">{stat}</Section>;
  }

  return (
    <Link
      to={href}
      className={cn(
        "flex flex-col gap-2 rounded p-2 transition-colors hover:bg-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
      aria-label={`Open ${title}`}
    >
      {stat}
    </Link>
  );
}

export type TopPodsCardProps = {
  title: string;
  description: string;
  items: TopPodMetric[];
  type: "cpu" | "memory";
  basePath: string;
};

export function TopPodsCard({
  title,
  description,
  items,
  type,
  basePath,
}: TopPodsCardProps) {
  const maxValue = items.reduce((max, item) => Math.max(max, item.value), 0);

  return (
    <Section>
      <SectionHeader title={title} description={description} />
      <SectionBody className="pt-2">
        {items.length > 0 ? (
          <div className="flex flex-col gap-2">
            {items.map((item, idx) => {
              const progress = maxValue
                ? Math.min(100, (item.value / maxValue) * 100)
                : 0;
              return (
                <Link
                  key={`${item.namespace}-${item.name}`}
                  to={`${basePath}/${item.namespace}/${item.name}`}
                  className="flex cursor-pointer flex-col gap-2 rounded p-2 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open pod ${item.namespace}/${item.name}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="px-2 text-[10px] font-medium"
                        >
                          #{idx + 1}
                        </Badge>
                        <span className="truncate text-sm font-medium">
                          {item.name}
                        </span>
                      </div>
                      <p className="text-xs text-fg-mut">{item.namespace}</p>
                    </div>
                    <MetricValue
                      used={item.value}
                      type={type}
                      className="shrink-0"
                    />
                  </div>
                  <Progress value={progress} className="h-1" />
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="p-2 text-sm text-fg-mut">No pod metrics available</p>
        )}
      </SectionBody>
    </Section>
  );
}

export function QuickActionTile({
  icon: Icon,
  label,
  description,
  href,
  onClick,
}: QuickActionTileProps) {
  const content = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-fg-mut transition-colors group-hover:text-fg" />
      <div className="space-y-1 text-left">
        <p className="text-sm font-medium leading-none">{label}</p>
        <p className="text-xs text-fg-mut">{description}</p>
      </div>
    </>
  );

  const className = cn(
    "group flex items-start gap-3 rounded border border-hair p-3",
    "transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  );

  if (href) {
    return (
      <Link to={href} className={className} aria-label={label}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
    >
      {content}
    </button>
  );
}
