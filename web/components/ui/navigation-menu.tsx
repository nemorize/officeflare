import { NavigationMenu } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { NavigationMenu };

export interface NavigationMenuPopupProps extends ComponentPropsWithRef<
  typeof NavigationMenu.Popup
> {
  portalProps?: Omit<NavigationMenu.Portal.Props, "children">;
  positionerProps?: Omit<NavigationMenu.Positioner.Props, "children">;
}

export function NavigationMenuPopup({
  portalProps,
  positionerProps,
  ...props
}: NavigationMenuPopupProps) {
  return (
    <NavigationMenu.Portal {...portalProps}>
      <NavigationMenu.Positioner data-ui="popup-positioner" {...positionerProps}>
        <NavigationMenu.Popup data-ui="navigation-menu-popup" {...props} />
      </NavigationMenu.Positioner>
    </NavigationMenu.Portal>
  );
}
