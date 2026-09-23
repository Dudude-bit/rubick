import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The overview's own shape while it loads: grouped key/value runs under
 * heading-sized bars, labels short and values uneven — the way the real
 * groups read. Five identical full-width rows promised a different screen,
 * and the swap to content was a jolt instead of a fill-in.
 */
const SKELETON_LABELS = ["w-10", "w-16", "w-12", "w-20"];
const SKELETON_VALUES = ["w-24", "w-40", "w-16", "w-32"];

export function PeekSkeleton() {
  return (
    <div aria-hidden="true" data-testid="peek-skeleton">
      {[4, 3].map((rows, group) => (
        <div key={group}>
          <div className="flex items-center pb-1 pt-4">
            <Skeleton className="h-2.5 w-24" />
          </div>
          {Array.from({ length: rows }).map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,132px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-[7px]"
            >
              <Skeleton
                className={cn(
                  "h-2.5",
                  SKELETON_LABELS[(group + index) % SKELETON_LABELS.length]
                )}
              />
              <Skeleton
                className={cn(
                  "h-2.5",
                  SKELETON_VALUES[(group * 2 + index) % SKELETON_VALUES.length]
                )}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
