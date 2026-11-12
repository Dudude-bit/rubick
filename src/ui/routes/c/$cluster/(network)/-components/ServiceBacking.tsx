import type { ReactNode } from "react";

import { Backing, useScopeBacking } from "./service-backing";

export function BackingAround({ children }: { children: ReactNode }) {
  const read = useScopeBacking();
  return <Backing.Provider value={read}>{children}</Backing.Provider>;
}
