import { createContext } from "react";

export interface PushState {
  loaded: boolean;
  available: boolean;
  supported: boolean;
  enabled: boolean;
  denied: boolean;
  busy: boolean;
  error: string;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}
export const PushContext = createContext<PushState | null>(null);
