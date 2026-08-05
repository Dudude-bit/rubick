import { Section, SectionHeader } from "@/components/ui/section";
import { ReactNode } from "react";

export interface MetadataCardProps<T> {
  /** Section title */
  title: string;
  /** Items to display */
  items: T[];
  /** Message to show when items array is empty */
  emptyMessage?: string;
  /** Render function for each item */
  renderItem: (item: T, index: number) => ReactNode;
  /** Container className for items */
  itemsContainerClassName?: string;
  /** Optional className for the section */
  className?: string;
}

/**
 * Generic section for displaying metadata items.
 * Used as a base for LabelsDisplay, ConditionsDisplay, and similar components.
 */
export function MetadataCard<T>({
  title,
  items,
  emptyMessage = "No items",
  renderItem,
  itemsContainerClassName = "space-y-2",
  className,
}: MetadataCardProps<T>) {
  return (
    <Section className={className}>
      <SectionHeader title={title} count={items.length || undefined} />
      {items.length === 0 ? (
        <p className="text-sm text-fg-mut">{emptyMessage}</p>
      ) : (
        <div className={itemsContainerClassName}>
          {items.map((item, index) => renderItem(item, index))}
        </div>
      )}
    </Section>
  );
}
