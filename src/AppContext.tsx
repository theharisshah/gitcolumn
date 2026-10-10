import { createContext, useContext } from 'react';

/** App-level operations available to repository windows. */
export interface AppActions {
  openRepo(path: string): void;
}

export const AppContext = createContext<AppActions>({ openRepo: () => undefined });

export const useApp = () => useContext(AppContext);
