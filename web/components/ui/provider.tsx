import { DirectionProvider } from "@base-ui/react/direction-provider";
import { Tooltip } from "./styled-primitives";
import { NotificationsProvider } from "./notifications";
import type { ReactNode } from "react";

export interface UIProviderProps {
  children: ReactNode;
  direction?: "ltr" | "rtl";
  tooltipProps?: Omit<Tooltip.Provider.Props, "children">;
}

export function UIProvider({ children, direction = "ltr", tooltipProps }: UIProviderProps) {
  return (
    <DirectionProvider direction={direction}>
      <Tooltip.Provider {...tooltipProps}><NotificationsProvider>{children}</NotificationsProvider></Tooltip.Provider>
    </DirectionProvider>
  );
}
