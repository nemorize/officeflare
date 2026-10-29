import { Dialog } from "./styled-primitives";
import { AlertDialog } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Dialog, AlertDialog };

export interface DialogPopupProps extends ComponentPropsWithRef<typeof Dialog.Popup> {
  padding?: "normal" | "none";
  layout?: "dialog" | "side-panel";
  portalProps?: Omit<Dialog.Portal.Props, "children">;
  backdropProps?: Dialog.Backdrop.Props;
  viewportProps?: Omit<Dialog.Viewport.Props, "children">;
}

export function DialogPopup({
  padding = "normal",
  layout = "dialog",
  portalProps,
  backdropProps,
  viewportProps,
  ...props
}: DialogPopupProps) {
  return (
    <Dialog.Portal {...portalProps}>
      <Dialog.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <Dialog.Viewport data-ui="dialog-viewport" data-layout={layout} {...viewportProps}>
        <Dialog.Popup
          data-ui="dialog-popup"
          data-layout={layout}
          data-padding={padding}
          {...props}
        />
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}

export type AlertDialogPopupProps = DialogPopupProps;

export function AlertDialogPopup({
  padding = "normal",
  layout = "dialog",
  portalProps,
  backdropProps,
  viewportProps,
  ...props
}: AlertDialogPopupProps) {
  return (
    <AlertDialog.Portal {...portalProps}>
      <AlertDialog.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <AlertDialog.Viewport data-ui="dialog-viewport" data-layout={layout} {...viewportProps}>
        <AlertDialog.Popup
          data-ui="dialog-popup"
          data-layout={layout}
          data-padding={padding}
          {...props}
        />
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  );
}
