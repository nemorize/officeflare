import { Tooltip } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Tooltip };

export interface TooltipPopupProps extends ComponentPropsWithRef<typeof Tooltip.Popup> {
  portalProps?: Omit<Tooltip.Portal.Props, "children">;
  positionerProps?: Omit<Tooltip.Positioner.Props, "children">;
}

export function TooltipPopup({ portalProps, positionerProps, ...props }: TooltipPopupProps) {
  return (
    <Tooltip.Portal {...portalProps}>
      <Tooltip.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Tooltip.Popup data-ui="tooltip-popup" {...props} />
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}
