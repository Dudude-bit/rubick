import { createContext } from "react";

/** The list around it has no rows because it was not read: notes about its columns have nothing to annotate. */
export const ListUnread = createContext(false);

/** The list around it was read and has no rows: a note about its measurements has nothing to measure. */
export const ListEmpty = createContext(false);

/** A notice above the list already offers the retry, and it asks metrics again too: a second button would ask the same reads. */
export const ListNoticeRetries = createContext(false);

/** The one width every notice above or in place of a list keeps. */
export const LIST_NOTICE_WIDTH = "max-w-[68ch]";
