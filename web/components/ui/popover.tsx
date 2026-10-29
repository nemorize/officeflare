import { Popover } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Popover };

export interface PopoverPopupProps extends ComponentPropsWithRef<typeof Popover.Popup> {
  padding?: "normal" | "none";
  portalProps?: Omit<Popover.Portal.Props, "children">;
  positionerProps?: Omit<Popover.Positioner.Props, "children">;
}

export function PopoverPopup({
  padding = "normal",
  portalProps,
  positionerProps,
  ...props
}: PopoverPopupProps) {
  return (
    <Popover.Portal {...portalProps}>
      <Popover.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Popover.Popup data-ui="popover-popup" data-padding={padding} {...props} />
      </Popover.Positioner>
    </Popover.Portal>
  );
}
