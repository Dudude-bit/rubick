import { createContext, useContext } from "react";

/** The object a surface reads its parts through, while its own read fails. */
export interface ObjectUnread {
  kind: string;
  name: string;
  failure: unknown;
}

export const ObjectUnreadContext = createContext<ObjectUnread | null>(null);

/** The object this part is read through, where its own read is failing now: the part then waits on it rather than saying a cause of its own. */
export const useObjectUnread = (): ObjectUnread | null =>
  useContext(ObjectUnreadContext);
