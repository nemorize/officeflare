import { Menu } from "@base-ui/react/menu";
import type { ComponentPropsWithRef } from "react";

export { Menu };

export interface MenuPopupProps extends ComponentPropsWithRef<typeof Menu.Popup> {
  portalProps?: Omit<Menu.Portal.Props, "children">;
  positionerProps?: Omit<Menu.Positioner.Props, "children">;
}

export function MenuPopup({ portalProps, positionerProps, ...props }: MenuPopupProps) {
  return (
    <Menu.Portal {...portalProps}>
      <Menu.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Menu.Popup data-ui="menu-popup" {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}
