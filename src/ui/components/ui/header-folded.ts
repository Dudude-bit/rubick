import { createContext, useContext } from "react";

export const HeaderFolded = createContext(false);

/** Inside a header row with no room for its actions' words: draw the icon alone. */
export const useHeaderFolded = () => useContext(HeaderFolded);
