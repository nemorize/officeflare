import { Select } from "@base-ui/react/select";
import { Combobox } from "@base-ui/react/combobox";
import type { ComponentPropsWithRef } from "react";

export { Select, Combobox };

export interface SelectPopupProps extends ComponentPropsWithRef<typeof Select.Popup> {
  portalProps?: Omit<Select.Portal.Props, "children">;
  positionerProps?: Omit<Select.Positioner.Props, "children">;
}

export function SelectPopup({ portalProps, positionerProps, ...props }: SelectPopupProps) {
  return (
    <Select.Portal {...portalProps}>
      <Select.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Select.Popup data-ui="select-popup" {...props} />
      </Select.Positioner>
    </Select.Portal>
  );
}

export interface ComboboxPopupProps extends ComponentPropsWithRef<typeof Combobox.Popup> {
  portalProps?: Omit<Combobox.Portal.Props, "children">;
  positionerProps?: Omit<Combobox.Positioner.Props, "children">;
}

export function ComboboxPopup({ portalProps, positionerProps, ...props }: ComboboxPopupProps) {
  return (
    <Combobox.Portal {...portalProps}>
      <Combobox.Positioner data-ui="popup-positioner" {...positionerProps}>
        <Combobox.Popup data-ui="combobox-popup" {...props} />
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}
