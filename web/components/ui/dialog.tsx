import { Dialog } from "./styled-primitives";
import { AlertDialog } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Dialog, AlertDialog };

export interface DialogPopupProps extends ComponentPropsWithRef<typeof Dialog.Popup> {
  portalProps?: Omit<Dialog.Portal.Props, "children">;
  backdropProps?: Dialog.Backdrop.Props;
  viewportProps?: Omit<Dialog.Viewport.Props, "children">;
}

export function DialogPopup({ portalProps, backdropProps, viewportProps, ...props }: DialogPopupProps) {
  return (
    <Dialog.Portal {...portalProps}>
      <Dialog.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <Dialog.Viewport data-ui="dialog-viewport" {...viewportProps}>
        <Dialog.Popup data-ui="dialog-popup" {...props} />
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}

export type AlertDialogPopupProps = DialogPopupProps;

export function AlertDialogPopup({ portalProps, backdropProps, viewportProps, ...props }: AlertDialogPopupProps) {
  return (
    <AlertDialog.Portal {...portalProps}>
      <AlertDialog.Backdrop data-ui="dialog-backdrop" {...backdropProps} />
      <AlertDialog.Viewport data-ui="dialog-viewport" {...viewportProps}>
        <AlertDialog.Popup data-ui="dialog-popup" {...props} />
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  );
}
