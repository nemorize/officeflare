import { PreviewCard } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { PreviewCard };

export interface PreviewCardPopupProps extends ComponentPropsWithRef<typeof PreviewCard.Popup> {
  portalProps?: Omit<PreviewCard.Portal.Props, "children">;
  positionerProps?: Omit<PreviewCard.Positioner.Props, "children">;
}

export function PreviewCardPopup({
  portalProps,
  positionerProps,
  ...props
}: PreviewCardPopupProps) {
  return (
    <PreviewCard.Portal {...portalProps}>
      <PreviewCard.Positioner data-ui="popup-positioner" {...positionerProps}>
        <PreviewCard.Popup data-ui="preview-card-popup" {...props} />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}
