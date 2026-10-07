import { Drawer } from "@base-ui/react/drawer";
import type { ComponentPropsWithRef } from "react";

export { Drawer };

export interface DrawerPopupProps extends ComponentPropsWithRef<typeof Drawer.Popup> {
  portalProps?: Omit<Drawer.Portal.Props, "children">;
  backdropProps?: Drawer.Backdrop.Props;
  viewportProps?: Omit<Drawer.Viewport.Props, "children">;
  contentProps?: Omit<Drawer.Content.Props, "children">;
}

export function DrawerPopup({ portalProps, backdropProps, viewportProps, contentProps, children, ...props }: DrawerPopupProps) {
  return (
    <Drawer.Portal {...portalProps}>
      <Drawer.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <Drawer.Viewport data-ui="drawer-viewport" {...viewportProps}>
        <Drawer.Popup data-ui="drawer-popup" {...props}>
          <Drawer.Content {...contentProps}>{children}</Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
}
