import { Drawer } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Drawer };

export interface DrawerPopupProps extends ComponentPropsWithRef<typeof Drawer.Popup> {
  side?: "bottom" | "left" | "right";
  padding?: "normal" | "none";
  portalProps?: Omit<Drawer.Portal.Props, "children">;
  backdropProps?: Drawer.Backdrop.Props;
  viewportProps?: Omit<Drawer.Viewport.Props, "children">;
  contentProps?: Omit<Drawer.Content.Props, "children">;
}

export function DrawerPopup({
  side = "bottom",
  padding = "normal",
  portalProps,
  backdropProps,
  viewportProps,
  contentProps,
  children,
  ...props
}: DrawerPopupProps) {
  return (
    <Drawer.Portal {...portalProps}>
      <Drawer.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <Drawer.Viewport data-ui="drawer-viewport" data-side={side} {...viewportProps}>
        <Drawer.Popup data-ui="drawer-popup" data-side={side} data-padding={padding} {...props}>
          <Drawer.Content {...contentProps}>{children}</Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
}
