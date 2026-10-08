import type { ReactNode } from "react";

import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useServiceBacking } from "@/hooks/useServiceBacking";
import { Backing } from "./service-backing";

export function BackingAround({ children }: { children: ReactNode }) {
  const scope = useNamespaceScope();
  const read = useServiceBacking(scope.wire);
  return <Backing.Provider value={read}>{children}</Backing.Provider>;
}
