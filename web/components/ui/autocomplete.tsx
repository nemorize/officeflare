import { Autocomplete } from "@base-ui/react/autocomplete";
import type { ComponentPropsWithRef } from "react";

export { Autocomplete };

export interface AutocompletePopupProps extends ComponentPropsWithRef<typeof Autocomplete.Popup> {
  portalProps?: Omit<Autocomplete.Portal.Props, "children">;
  positionerProps?: Omit<Autocomplete.Positioner.Props, "children">;
}

export function AutocompletePopup({ portalProps, positionerProps, ...props }: AutocompletePopupProps) {
  return (
    <Autocomplete.Portal {...portalProps}>
      <Autocomplete.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Autocomplete.Popup data-ui="autocomplete-popup" {...props} />
      </Autocomplete.Positioner>
    </Autocomplete.Portal>
  );
}
