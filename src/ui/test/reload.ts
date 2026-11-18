interface Persisted<S> {
  getInitialState: () => S;
  setState: (state: S, replace: true) => void;
  persist: {
    getOptions: () => { name?: string };
    rehydrate: () => Promise<void> | void;
  };
}

/**
 * A persisted store as the next start finds it: emptied to how it begins,
 * then read back from what it had stored.
 */
export async function reload<S>(store: Persisted<S>): Promise<void> {
  const name = store.persist.getOptions().name!;
  const stored = localStorage.getItem(name);
  store.setState(store.getInitialState(), true);
  if (stored === null) localStorage.removeItem(name);
  else localStorage.setItem(name, stored);
  await store.persist.rehydrate();
}
