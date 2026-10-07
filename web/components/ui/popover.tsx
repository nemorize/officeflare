import { Popover } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Popover };

export interface PopoverPopupProps extends ComponentPropsWithRef<typeof Popover.Popup> {
  portalProps?: Omit<Popover.Portal.Props, "children">;
  positionerProps?: Omit<Popover.Positioner.Props, "children">;
}

export function PopoverPopup({ portalProps, positionerProps, ...props }: PopoverPopupProps) {
  return (
    <Popover.Portal {...portalProps}>
      <Popover.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Popover.Popup data-ui="popover-popup" {...props} />
      </Popover.Positioner>
    </Popover.Portal>
  );
}
