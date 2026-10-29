import { ContextMenu } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { ContextMenu };

export interface ContextMenuPopupProps extends ComponentPropsWithRef<typeof ContextMenu.Popup> {
  portalProps?: Omit<ContextMenu.Portal.Props, "children">;
  positionerProps?: Omit<ContextMenu.Positioner.Props, "children">;
}

export function ContextMenuPopup({
  portalProps,
  positionerProps,
  ...props
}: ContextMenuPopupProps) {
  return (
    <ContextMenu.Portal {...portalProps}>
      <ContextMenu.Positioner data-ui="popup-positioner" {...positionerProps}>
        <ContextMenu.Popup data-ui="context-menu-popup" {...props} />
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}
