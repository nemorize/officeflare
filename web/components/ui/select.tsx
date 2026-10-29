import { Select } from "./styled-primitives";
import { Combobox } from "./styled-primitives";
import type { ComponentPropsWithRef } from "react";

export { Select, Combobox };

export interface SelectPopupProps extends ComponentPropsWithRef<typeof Select.Popup> {
  portalProps?: Omit<Select.Portal.Props, "children">;
  positionerProps?: Omit<Select.Positioner.Props, "children">;
}

export function SelectPopup({ portalProps, positionerProps, ...props }: SelectPopupProps) {
  return (
    <Select.Portal {...portalProps}>
      <Select.Positioner
        data-ui="popup-positioner"
        align="start"
        alignItemWithTrigger={false}
        sideOffset={6}
        {...positionerProps}
      >
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
      <Combobox.Positioner
        data-ui="popup-positioner"
        align="start"
        sideOffset={6}
        {...positionerProps}
      >
        <Combobox.Popup data-ui="combobox-popup" {...props} />
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}
