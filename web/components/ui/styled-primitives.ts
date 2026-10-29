// Styling hooks for all Base UI parts; the original props and event types are retained.
import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup as BaseCheckboxGroup } from "@base-ui/react/checkbox-group";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { Field as BaseField } from "@base-ui/react/field";
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset";
import { Form as BaseForm } from "@base-ui/react/form";
import { Menubar as BaseMenubar } from "@base-ui/react/menubar";
import { Meter as BaseMeter } from "@base-ui/react/meter";
import { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import { OTPField as BaseOTPField } from "@base-ui/react/otp-field";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { Toolbar as BaseToolbar } from "@base-ui/react/toolbar";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { NavigationMenu as BaseNavigationMenu } from "@base-ui/react/navigation-menu";
import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import { styledPart, styledParts } from "./styled";

export const Accordion = /* @__PURE__ */ styledParts(BaseAccordion, {
  Root: "accordion-root",
  Item: "accordion-item",
  Header: "accordion-header",
  Trigger: "accordion-trigger",
  Panel: "accordion-panel",
});
export declare namespace Accordion {
  namespace Root {
    type Value<TValue = any> = BaseAccordion.Root.Value<TValue>;
    type State<TValue = any> = BaseAccordion.Root.State<TValue>;
    type Props<TValue = any> = BaseAccordion.Root.Props<TValue>;
    type ChangeEventReason = BaseAccordion.Root.ChangeEventReason;
    type ChangeEventDetails = BaseAccordion.Root.ChangeEventDetails;
  }
  namespace Item {
    type State = BaseAccordion.Item.State;
    type Props = BaseAccordion.Item.Props;
    type ChangeEventReason = BaseAccordion.Item.ChangeEventReason;
    type ChangeEventDetails = BaseAccordion.Item.ChangeEventDetails;
  }
  namespace Header {
    type State = BaseAccordion.Header.State;
    type Props = BaseAccordion.Header.Props;
  }
  namespace Trigger {
    type State = BaseAccordion.Trigger.State;
    type Props = BaseAccordion.Trigger.Props;
  }
  namespace Panel {
    type State = BaseAccordion.Panel.State;
    type Props = BaseAccordion.Panel.Props;
  }
}

export const Avatar = /* @__PURE__ */ styledParts(BaseAvatar, {
  Root: "avatar-root",
  Image: "avatar-image",
  Fallback: "avatar-fallback",
});
export declare namespace Avatar {
  namespace Root {
    type State = BaseAvatar.Root.State;
    type Props = BaseAvatar.Root.Props;
  }
  namespace Image {
    type State = BaseAvatar.Image.State;
    type Props = BaseAvatar.Image.Props;
  }
  namespace Fallback {
    type State = BaseAvatar.Fallback.State;
    type Props = BaseAvatar.Fallback.Props;
  }
}

export const Checkbox = /* @__PURE__ */ styledParts(BaseCheckbox, {
  Root: "checkbox-root",
  Indicator: "checkbox-indicator",
});
export declare namespace Checkbox {
  namespace Root {
    type State = BaseCheckbox.Root.State;
    type Props = BaseCheckbox.Root.Props;
    type ChangeEventReason = BaseCheckbox.Root.ChangeEventReason;
    type ChangeEventDetails = BaseCheckbox.Root.ChangeEventDetails;
  }
  namespace Indicator {
    type State = BaseCheckbox.Indicator.State;
    type Props = BaseCheckbox.Indicator.Props;
  }
}

export const CheckboxGroup = /* @__PURE__ */ styledPart(BaseCheckboxGroup, "checkbox-group");
export declare namespace CheckboxGroup {
  type State = BaseCheckboxGroup.State;
  type Props = BaseCheckboxGroup.Props;
  type ChangeEventReason = BaseCheckboxGroup.ChangeEventReason;
  type ChangeEventDetails = BaseCheckboxGroup.ChangeEventDetails;
}

export const Collapsible = /* @__PURE__ */ styledParts(BaseCollapsible, {
  Root: "collapsible-root",
  Trigger: "collapsible-trigger",
  Panel: "collapsible-panel",
});
export declare namespace Collapsible {
  namespace Root {
    type State = BaseCollapsible.Root.State;
    type Props = BaseCollapsible.Root.Props;
    type ChangeEventReason = BaseCollapsible.Root.ChangeEventReason;
    type ChangeEventDetails = BaseCollapsible.Root.ChangeEventDetails;
  }
  namespace Trigger {
    type State = BaseCollapsible.Trigger.State;
    type Props = BaseCollapsible.Trigger.Props;
  }
  namespace Panel {
    type State = BaseCollapsible.Panel.State;
    type Props = BaseCollapsible.Panel.Props;
  }
}

export const Field = /* @__PURE__ */ styledParts(BaseField, {
  Root: "field-root",
  Label: "field-label",
  Error: "field-error",
  Description: "field-description",
  Control: "field-control",
  Item: "field-item",
});
export declare namespace Field {
  namespace Root {
    type State = BaseField.Root.State;
    type Props = BaseField.Root.Props;
    type Actions = BaseField.Root.Actions;
  }
  namespace Label {
    type State = BaseField.Label.State;
    type Props = BaseField.Label.Props;
  }
  namespace Error {
    type State = BaseField.Error.State;
    type Props = BaseField.Error.Props;
  }
  namespace Description {
    type State = BaseField.Description.State;
    type Props = BaseField.Description.Props;
  }
  namespace Control {
    type State = BaseField.Control.State;
    type Props = BaseField.Control.Props;
    type ChangeEventReason = BaseField.Control.ChangeEventReason;
    type ChangeEventDetails = BaseField.Control.ChangeEventDetails;
  }
  namespace Validity {
    type State = BaseField.Validity.State;
    type Props = BaseField.Validity.Props;
  }
  namespace Item {
    type State = BaseField.Item.State;
    type Props = BaseField.Item.Props;
  }
}

export const Fieldset = /* @__PURE__ */ styledParts(BaseFieldset, {
  Root: "fieldset-root",
  Legend: "fieldset-legend",
});
export declare namespace Fieldset {
  namespace Root {
    type State = BaseFieldset.Root.State;
    type Props = BaseFieldset.Root.Props;
  }
  namespace Legend {
    type State = BaseFieldset.Legend.State;
    type Props = BaseFieldset.Legend.Props;
  }
}

export const Form = /* @__PURE__ */ styledPart(BaseForm, "form");
export declare namespace Form {
  type Props<FormValues extends Record<string, any> = Record<string, any>> =
    BaseForm.Props<FormValues>;
  type State = BaseForm.State;
  type Actions = BaseForm.Actions;
  type ValidationMode = BaseForm.ValidationMode;
  type SubmitEventReason = BaseForm.SubmitEventReason;
  type SubmitEventDetails = BaseForm.SubmitEventDetails;
  type Values<FormValues extends Record<string, any> = Record<string, any>> =
    BaseForm.Values<FormValues>;
}

export const Menubar = /* @__PURE__ */ styledPart(BaseMenubar, "menubar");
export declare namespace Menubar {
  type State = BaseMenubar.State;
  type Props = BaseMenubar.Props;
}

export const Meter = /* @__PURE__ */ styledParts(BaseMeter, {
  Root: "meter-root",
  Track: "meter-track",
  Indicator: "meter-indicator",
  Value: "meter-value",
  Label: "meter-label",
});
export declare namespace Meter {
  namespace Root {
    type State = BaseMeter.Root.State;
    type Props = BaseMeter.Root.Props;
  }
  namespace Track {
    type State = BaseMeter.Track.State;
    type Props = BaseMeter.Track.Props;
  }
  namespace Indicator {
    type State = BaseMeter.Indicator.State;
    type Props = BaseMeter.Indicator.Props;
  }
  namespace Value {
    type State = BaseMeter.Value.State;
    type Props = BaseMeter.Value.Props;
  }
  namespace Label {
    type State = BaseMeter.Label.State;
    type Props = BaseMeter.Label.Props;
  }
}

export const NumberField = /* @__PURE__ */ styledParts(BaseNumberField, {
  Root: "number-field-root",
  Group: "number-field-group",
  Increment: "number-field-increment",
  Decrement: "number-field-decrement",
  Input: "number-field-input",
  ScrubArea: "number-field-scrub-area",
  ScrubAreaCursor: "number-field-scrub-area-cursor",
});
export declare namespace NumberField {
  namespace Root {
    type State = BaseNumberField.Root.State;
    type Props = BaseNumberField.Root.Props;
    type ChangeEventReason = BaseNumberField.Root.ChangeEventReason;
    type ChangeEventDetails = BaseNumberField.Root.ChangeEventDetails;
    type CommitEventReason = BaseNumberField.Root.CommitEventReason;
    type CommitEventDetails = BaseNumberField.Root.CommitEventDetails;
  }
  namespace Group {
    type State = BaseNumberField.Group.State;
    type Props = BaseNumberField.Group.Props;
  }
  namespace Increment {
    type State = BaseNumberField.Increment.State;
    type Props = BaseNumberField.Increment.Props;
  }
  namespace Decrement {
    type State = BaseNumberField.Decrement.State;
    type Props = BaseNumberField.Decrement.Props;
  }
  namespace Input {
    type State = BaseNumberField.Input.State;
    type Props = BaseNumberField.Input.Props;
  }
  namespace ScrubArea {
    type State = BaseNumberField.ScrubArea.State;
    type Props = BaseNumberField.ScrubArea.Props;
  }
  namespace ScrubAreaCursor {
    type State = BaseNumberField.ScrubAreaCursor.State;
    type Props = BaseNumberField.ScrubAreaCursor.Props;
  }
}

export const OTPField = /* @__PURE__ */ styledParts(BaseOTPField, {
  Root: "otp-field-root",
  Input: "otp-field-input",
  Separator: "otp-field-separator",
});
export declare namespace OTPField {
  namespace Root {
    type State = BaseOTPField.Root.State;
    type Props = BaseOTPField.Root.Props;
    type ValidationType = BaseOTPField.Root.ValidationType;
    type ChangeEventReason = BaseOTPField.Root.ChangeEventReason;
    type ChangeEventDetails = BaseOTPField.Root.ChangeEventDetails;
    type InvalidEventReason = BaseOTPField.Root.InvalidEventReason;
    type InvalidEventDetails = BaseOTPField.Root.InvalidEventDetails;
    type CompleteEventReason = BaseOTPField.Root.CompleteEventReason;
    type CompleteEventDetails = BaseOTPField.Root.CompleteEventDetails;
  }
  namespace Input {
    type State = BaseOTPField.Input.State;
    type Props = BaseOTPField.Input.Props;
  }
  namespace Separator {
    type Props = BaseOTPField.Separator.Props;
    type State = BaseOTPField.Separator.State;
  }
}

export const Progress = /* @__PURE__ */ styledParts(BaseProgress, {
  Root: "progress-root",
  Track: "progress-track",
  Indicator: "progress-indicator",
  Value: "progress-value",
  Label: "progress-label",
});
export declare namespace Progress {
  namespace Root {
    type State = BaseProgress.Root.State;
    type Props = BaseProgress.Root.Props;
  }
  namespace Track {
    type State = BaseProgress.Track.State;
    type Props = BaseProgress.Track.Props;
  }
  namespace Indicator {
    type State = BaseProgress.Indicator.State;
    type Props = BaseProgress.Indicator.Props;
  }
  namespace Value {
    type State = BaseProgress.Value.State;
    type Props = BaseProgress.Value.Props;
  }
  namespace Label {
    type State = BaseProgress.Label.State;
    type Props = BaseProgress.Label.Props;
  }
}

export const Radio = /* @__PURE__ */ styledParts(BaseRadio, {
  Root: "radio-root",
  Indicator: "radio-indicator",
});
export declare namespace Radio {
  namespace Root {
    type State = BaseRadio.Root.State;
    type Props<TValue = any> = BaseRadio.Root.Props<TValue>;
  }
  namespace Indicator {
    type Props = BaseRadio.Indicator.Props;
    type State = BaseRadio.Indicator.State;
  }
}

export const RadioGroup = /* @__PURE__ */ styledPart(BaseRadioGroup, "radio-group");
export declare namespace RadioGroup {
  type State = BaseRadioGroup.State;
  type Props<TValue = any> = BaseRadioGroup.Props<TValue>;
  type ChangeEventReason = BaseRadioGroup.ChangeEventReason;
  type ChangeEventDetails = BaseRadioGroup.ChangeEventDetails;
}

export const ScrollArea = /* @__PURE__ */ styledParts(BaseScrollArea, {
  Root: "scroll-area-root",
  Viewport: "scroll-area-viewport",
  Scrollbar: "scroll-area-scrollbar",
  Content: "scroll-area-content",
  Thumb: "scroll-area-thumb",
  Corner: "scroll-area-corner",
});
export declare namespace ScrollArea {
  namespace Root {
    type State = BaseScrollArea.Root.State;
    type Props = BaseScrollArea.Root.Props;
  }
  namespace Viewport {
    type Props = BaseScrollArea.Viewport.Props;
    type State = BaseScrollArea.Viewport.State;
  }
  namespace Scrollbar {
    type State = BaseScrollArea.Scrollbar.State;
    type Props = BaseScrollArea.Scrollbar.Props;
  }
  namespace Content {
    type State = BaseScrollArea.Content.State;
    type Props = BaseScrollArea.Content.Props;
  }
  namespace Thumb {
    type State = BaseScrollArea.Thumb.State;
    type Props = BaseScrollArea.Thumb.Props;
  }
  namespace Corner {
    type State = BaseScrollArea.Corner.State;
    type Props = BaseScrollArea.Corner.Props;
  }
}

export const Separator = /* @__PURE__ */ styledPart(BaseSeparator, "separator");
export declare namespace Separator {
  type Props = BaseSeparator.Props;
  type State = BaseSeparator.State;
}

export const Slider = /* @__PURE__ */ styledParts(BaseSlider, {
  Root: "slider-root",
  Label: "slider-label",
  Value: "slider-value",
  Control: "slider-control",
  Track: "slider-track",
  Thumb: "slider-thumb",
  Indicator: "slider-indicator",
});
export declare namespace Slider {
  namespace Root {
    type State = BaseSlider.Root.State;
    type Props<Value extends number | readonly number[] = number | readonly number[]> =
      BaseSlider.Root.Props<Value>;
    type ChangeEventReason = BaseSlider.Root.ChangeEventReason;
    type ChangeEventDetails = BaseSlider.Root.ChangeEventDetails;
    type CommitEventReason = BaseSlider.Root.CommitEventReason;
    type CommitEventDetails = BaseSlider.Root.CommitEventDetails;
  }
  namespace Label {
    type State = BaseSlider.Label.State;
    type Props = BaseSlider.Label.Props;
  }
  namespace Value {
    type State = BaseSlider.Value.State;
    type Props = BaseSlider.Value.Props;
  }
  namespace Control {
    type State = BaseSlider.Control.State;
    type Props = BaseSlider.Control.Props;
  }
  namespace Track {
    type State = BaseSlider.Track.State;
    type Props = BaseSlider.Track.Props;
  }
  namespace Thumb {
    type State = BaseSlider.Thumb.State;
    type Props = BaseSlider.Thumb.Props;
  }
  namespace Indicator {
    type State = BaseSlider.Indicator.State;
    type Props = BaseSlider.Indicator.Props;
  }
}

export const Switch = /* @__PURE__ */ styledParts(BaseSwitch, {
  Root: "switch-root",
  Thumb: "switch-thumb",
});
export declare namespace Switch {
  namespace Root {
    type State = BaseSwitch.Root.State;
    type Props = BaseSwitch.Root.Props;
    type ChangeEventReason = BaseSwitch.Root.ChangeEventReason;
    type ChangeEventDetails = BaseSwitch.Root.ChangeEventDetails;
  }
  namespace Thumb {
    type Props = BaseSwitch.Thumb.Props;
    type State = BaseSwitch.Thumb.State;
  }
}

export const Tabs = /* @__PURE__ */ styledParts(BaseTabs, {
  Root: "tabs-root",
  Tab: "tabs-tab",
  Indicator: "tabs-indicator",
  Panel: "tabs-panel",
  List: "tabs-list",
});
export declare namespace Tabs {
  namespace Root {
    type State = BaseTabs.Root.State;
    type Props = BaseTabs.Root.Props;
    type Orientation = BaseTabs.Root.Orientation;
    type ChangeEventReason = BaseTabs.Root.ChangeEventReason;
    type ChangeEventDetails = BaseTabs.Root.ChangeEventDetails;
  }
  namespace Tab {
    type Value = BaseTabs.Tab.Value;
    type ActivationDirection = BaseTabs.Tab.ActivationDirection;
    type Position = BaseTabs.Tab.Position;
    type Size = BaseTabs.Tab.Size;
    type Metadata = BaseTabs.Tab.Metadata;
    type State = BaseTabs.Tab.State;
    type Props = BaseTabs.Tab.Props;
  }
  namespace Indicator {
    type State = BaseTabs.Indicator.State;
    type Props = BaseTabs.Indicator.Props;
  }
  namespace Panel {
    type Metadata = BaseTabs.Panel.Metadata;
    type State = BaseTabs.Panel.State;
    type Props = BaseTabs.Panel.Props;
  }
  namespace List {
    type State = BaseTabs.List.State;
    type Props = BaseTabs.List.Props;
  }
}

export const Toast = /* @__PURE__ */ styledParts(BaseToast, {
  Viewport: "toast-viewport",
  Root: "toast-root",
  Content: "toast-content",
  Description: "toast-description",
  Title: "toast-title",
  Close: "toast-close",
  Action: "toast-action",
  Positioner: "toast-positioner",
  Arrow: "toast-arrow",
});
export declare namespace Toast {
  namespace Provider {
    type State = BaseToast.Provider.State;
    type Props = BaseToast.Provider.Props;
  }
  namespace Viewport {
    type State = BaseToast.Viewport.State;
    type Props = BaseToast.Viewport.Props;
  }
  namespace Root {
    type ToastObject<Data extends object = any> = BaseToast.Root.ToastObject<Data>;
    type State = BaseToast.Root.State;
    type Props = BaseToast.Root.Props;
  }
  namespace Content {
    type State = BaseToast.Content.State;
    type Props = BaseToast.Content.Props;
  }
  namespace Description {
    type State = BaseToast.Description.State;
    type Props = BaseToast.Description.Props;
  }
  namespace Title {
    type State = BaseToast.Title.State;
    type Props = BaseToast.Title.Props;
  }
  namespace Close {
    type State = BaseToast.Close.State;
    type Props = BaseToast.Close.Props;
  }
  namespace Action {
    type State = BaseToast.Action.State;
    type Props = BaseToast.Action.Props;
  }
  namespace Portal {
    type State = BaseToast.Portal.State;
    type Props = BaseToast.Portal.Props;
  }
  namespace Positioner {
    type State = BaseToast.Positioner.State;
    type Props = BaseToast.Positioner.Props;
  }
  namespace Arrow {
    type State = BaseToast.Arrow.State;
    type Props = BaseToast.Arrow.Props;
  }
}

export const Toggle = /* @__PURE__ */ styledPart(BaseToggle, "toggle");
export declare namespace Toggle {
  type State = BaseToggle.State;
  type Props<TValue extends string = string> = BaseToggle.Props<TValue>;
  type ChangeEventReason = BaseToggle.ChangeEventReason;
  type ChangeEventDetails = BaseToggle.ChangeEventDetails;
}

export const ToggleGroup = /* @__PURE__ */ styledPart(BaseToggleGroup, "toggle-group");
export declare namespace ToggleGroup {
  type State = BaseToggleGroup.State;
  type Props<Value extends string = string> = BaseToggleGroup.Props<Value>;
  type ChangeEventReason = BaseToggleGroup.ChangeEventReason;
  type ChangeEventDetails = BaseToggleGroup.ChangeEventDetails;
}

export const Toolbar = /* @__PURE__ */ styledParts(BaseToolbar, {
  Separator: "toolbar-separator",
  Root: "toolbar-root",
  Group: "toolbar-group",
  Button: "toolbar-button",
  Link: "toolbar-link",
  Input: "toolbar-input",
});
export declare namespace Toolbar {
  namespace Separator {
    type State = BaseToolbar.Separator.State;
    type Props = BaseToolbar.Separator.Props;
  }
  namespace Root {
    type ItemMetadata = BaseToolbar.Root.ItemMetadata;
    type Orientation = BaseToolbar.Root.Orientation;
    type State = BaseToolbar.Root.State;
    type Props = BaseToolbar.Root.Props;
  }
  namespace Group {
    type State = BaseToolbar.Group.State;
    type Props = BaseToolbar.Group.Props;
  }
  namespace Button {
    type State = BaseToolbar.Button.State;
    type Props = BaseToolbar.Button.Props;
  }
  namespace Link {
    type State = BaseToolbar.Link.State;
    type Props = BaseToolbar.Link.Props;
  }
  namespace Input {
    type State = BaseToolbar.Input.State;
    type Props = BaseToolbar.Input.Props;
  }
}

export const Dialog = /* @__PURE__ */ styledParts(BaseDialog, {
  Backdrop: "dialog-backdrop",
  Close: "dialog-close",
  Description: "dialog-description",
  Popup: "dialog-popup",
  Viewport: "dialog-viewport",
  Title: "dialog-title",
  Trigger: "dialog-trigger",
});
export declare namespace Dialog {
  namespace Backdrop {
    type Props = BaseDialog.Backdrop.Props;
    type State = BaseDialog.Backdrop.State;
  }
  namespace Close {
    type Props = BaseDialog.Close.Props;
    type State = BaseDialog.Close.State;
  }
  namespace Description {
    type Props = BaseDialog.Description.Props;
    type State = BaseDialog.Description.State;
  }
  namespace Popup {
    type Props = BaseDialog.Popup.Props;
    type State = BaseDialog.Popup.State;
  }
  namespace Portal {
    type State = BaseDialog.Portal.State;
    type Props = BaseDialog.Portal.Props;
  }
  namespace Root {
    type State = BaseDialog.Root.State;
    type Props<Payload = unknown> = BaseDialog.Root.Props<Payload>;
    type Actions = BaseDialog.Root.Actions;
    type ChangeEventReason = BaseDialog.Root.ChangeEventReason;
    type ChangeEventDetails = BaseDialog.Root.ChangeEventDetails;
  }
  namespace Viewport {
    type State = BaseDialog.Viewport.State;
    type Props = BaseDialog.Viewport.Props;
  }
  namespace Title {
    type Props = BaseDialog.Title.Props;
    type State = BaseDialog.Title.State;
  }
  namespace Trigger {
    type Props<Payload = unknown> = BaseDialog.Trigger.Props<Payload>;
    type State = BaseDialog.Trigger.State;
  }
}

export const AlertDialog = /* @__PURE__ */ styledParts(BaseAlertDialog, {
  Backdrop: "alert-dialog-backdrop",
  Close: "alert-dialog-close",
  Description: "alert-dialog-description",
  Popup: "alert-dialog-popup",
  Title: "alert-dialog-title",
  Trigger: "alert-dialog-trigger",
  Viewport: "alert-dialog-viewport",
});
export declare namespace AlertDialog {
  namespace Root {
    type State = BaseAlertDialog.Root.State;
    type Props<Payload = unknown> = BaseAlertDialog.Root.Props<Payload>;
    type Actions = BaseAlertDialog.Root.Actions;
    type ChangeEventReason = BaseAlertDialog.Root.ChangeEventReason;
    type ChangeEventDetails = BaseAlertDialog.Root.ChangeEventDetails;
  }
  namespace Backdrop {
    type Props = BaseAlertDialog.Backdrop.Props;
    type State = BaseAlertDialog.Backdrop.State;
  }
  namespace Close {
    type Props = BaseAlertDialog.Close.Props;
    type State = BaseAlertDialog.Close.State;
  }
  namespace Description {
    type Props = BaseAlertDialog.Description.Props;
    type State = BaseAlertDialog.Description.State;
  }
  namespace Popup {
    type Props = BaseAlertDialog.Popup.Props;
    type State = BaseAlertDialog.Popup.State;
  }
  namespace Portal {
    type State = BaseAlertDialog.Portal.State;
    type Props = BaseAlertDialog.Portal.Props;
  }
  namespace Title {
    type Props = BaseAlertDialog.Title.Props;
    type State = BaseAlertDialog.Title.State;
  }
  namespace Trigger {
    type Props<Payload = unknown> = BaseAlertDialog.Trigger.Props<Payload>;
    type State = BaseAlertDialog.Trigger.State;
  }
  namespace Viewport {
    type State = BaseAlertDialog.Viewport.State;
    type Props = BaseAlertDialog.Viewport.Props;
  }
}

export const Popover = /* @__PURE__ */ styledParts(BasePopover, {
  Trigger: "popover-trigger",
  Positioner: "popover-positioner",
  Popup: "popover-popup",
  Arrow: "popover-arrow",
  Backdrop: "popover-backdrop",
  Title: "popover-title",
  Description: "popover-description",
  Close: "popover-close",
  Viewport: "popover-viewport",
});
export declare namespace Popover {
  namespace Root {
    type State = BasePopover.Root.State;
    type Props<Payload = unknown> = BasePopover.Root.Props<Payload>;
    type Actions = BasePopover.Root.Actions;
    type ChangeEventReason = BasePopover.Root.ChangeEventReason;
    type ChangeEventDetails = BasePopover.Root.ChangeEventDetails;
  }
  namespace Trigger {
    type State = BasePopover.Trigger.State;
    type Props<Payload = unknown> = BasePopover.Trigger.Props<Payload>;
  }
  namespace Portal {
    type State = BasePopover.Portal.State;
    type Props = BasePopover.Portal.Props;
  }
  namespace Positioner {
    type State = BasePopover.Positioner.State;
    type Props = BasePopover.Positioner.Props;
  }
  namespace Popup {
    type State = BasePopover.Popup.State;
    type Props = BasePopover.Popup.Props;
  }
  namespace Arrow {
    type State = BasePopover.Arrow.State;
    type Props = BasePopover.Arrow.Props;
  }
  namespace Backdrop {
    type State = BasePopover.Backdrop.State;
    type Props = BasePopover.Backdrop.Props;
  }
  namespace Title {
    type State = BasePopover.Title.State;
    type Props = BasePopover.Title.Props;
  }
  namespace Description {
    type State = BasePopover.Description.State;
    type Props = BasePopover.Description.Props;
  }
  namespace Close {
    type State = BasePopover.Close.State;
    type Props = BasePopover.Close.Props;
  }
  namespace Viewport {
    type Props = BasePopover.Viewport.Props;
    type State = BasePopover.Viewport.State;
  }
}

export const Menu = /* @__PURE__ */ styledParts(BaseMenu, {
  Arrow: "menu-arrow",
  Backdrop: "menu-backdrop",
  CheckboxItem: "menu-checkbox-item",
  CheckboxItemIndicator: "menu-checkbox-item-indicator",
  Group: "menu-group",
  GroupLabel: "menu-group-label",
  Item: "menu-item",
  LinkItem: "menu-link-item",
  Popup: "menu-popup",
  Positioner: "menu-positioner",
  RadioGroup: "menu-radio-group",
  RadioItem: "menu-radio-item",
  RadioItemIndicator: "menu-radio-item-indicator",
  SubmenuRoot: "menu-submenu-root",
  Trigger: "menu-trigger",
  Viewport: "menu-viewport",
  Separator: "menu-separator",
  SubmenuTrigger: "menu-submenu-trigger",
});
export declare namespace Menu {
  namespace Arrow {
    type State = BaseMenu.Arrow.State;
    type Props = BaseMenu.Arrow.Props;
  }
  namespace Backdrop {
    type State = BaseMenu.Backdrop.State;
    type Props = BaseMenu.Backdrop.Props;
  }
  namespace CheckboxItem {
    type State = BaseMenu.CheckboxItem.State;
    type Props = BaseMenu.CheckboxItem.Props;
    type ChangeEventReason = BaseMenu.CheckboxItem.ChangeEventReason;
    type ChangeEventDetails = BaseMenu.CheckboxItem.ChangeEventDetails;
  }
  namespace CheckboxItemIndicator {
    type Props = BaseMenu.CheckboxItemIndicator.Props;
    type State = BaseMenu.CheckboxItemIndicator.State;
  }
  namespace Group {
    type Props = BaseMenu.Group.Props;
    type State = BaseMenu.Group.State;
  }
  namespace GroupLabel {
    type Props = BaseMenu.GroupLabel.Props;
    type State = BaseMenu.GroupLabel.State;
  }
  namespace Item {
    type State = BaseMenu.Item.State;
    type Props = BaseMenu.Item.Props;
  }
  namespace LinkItem {
    type State = BaseMenu.LinkItem.State;
    type Props = BaseMenu.LinkItem.Props;
  }
  namespace Popup {
    type Props = BaseMenu.Popup.Props;
    type State = BaseMenu.Popup.State;
  }
  namespace Portal {
    type State = BaseMenu.Portal.State;
    type Props = BaseMenu.Portal.Props;
  }
  namespace Positioner {
    type State = BaseMenu.Positioner.State;
    type Props = BaseMenu.Positioner.Props;
  }
  namespace RadioGroup {
    type Props = BaseMenu.RadioGroup.Props;
    type State = BaseMenu.RadioGroup.State;
    type ChangeEventReason = BaseMenu.RadioGroup.ChangeEventReason;
    type ChangeEventDetails = BaseMenu.RadioGroup.ChangeEventDetails;
  }
  namespace RadioItem {
    type State = BaseMenu.RadioItem.State;
    type Props = BaseMenu.RadioItem.Props;
  }
  namespace RadioItemIndicator {
    type Props = BaseMenu.RadioItemIndicator.Props;
    type State = BaseMenu.RadioItemIndicator.State;
  }
  namespace Root {
    type State = BaseMenu.Root.State;
    type Props<Payload = unknown> = BaseMenu.Root.Props<Payload>;
    type Actions = BaseMenu.Root.Actions;
    type ChangeEventReason = BaseMenu.Root.ChangeEventReason;
    type ChangeEventDetails = BaseMenu.Root.ChangeEventDetails;
    type Orientation = BaseMenu.Root.Orientation;
  }
  namespace SubmenuRoot {
    type Props = BaseMenu.SubmenuRoot.Props;
    type State = BaseMenu.SubmenuRoot.State;
    type ChangeEventReason = BaseMenu.SubmenuRoot.ChangeEventReason;
    type ChangeEventDetails = BaseMenu.SubmenuRoot.ChangeEventDetails;
  }
  namespace Trigger {
    type Props<Payload = unknown> = BaseMenu.Trigger.Props<Payload>;
    type State = BaseMenu.Trigger.State;
  }
  namespace Viewport {
    type Props = BaseMenu.Viewport.Props;
    type State = BaseMenu.Viewport.State;
  }
  namespace Separator {
    type Props = BaseMenu.Separator.Props;
    type State = BaseMenu.Separator.State;
  }
  namespace SubmenuTrigger {
    type Props = BaseMenu.SubmenuTrigger.Props;
    type State = BaseMenu.SubmenuTrigger.State;
  }
}

export const Select = /* @__PURE__ */ styledParts(BaseSelect, {
  Label: "select-label",
  Trigger: "select-trigger",
  Value: "select-value",
  Icon: "select-icon",
  Backdrop: "select-backdrop",
  Positioner: "select-positioner",
  Popup: "select-popup",
  List: "select-list",
  Item: "select-item",
  ItemIndicator: "select-item-indicator",
  ItemText: "select-item-text",
  Arrow: "select-arrow",
  ScrollDownArrow: "select-scroll-down-arrow",
  ScrollUpArrow: "select-scroll-up-arrow",
  Group: "select-group",
  GroupLabel: "select-group-label",
  Separator: "select-separator",
});
export declare namespace Select {
  namespace Root {
    type Props<Value, Multiple extends boolean | undefined = false> = BaseSelect.Root.Props<
      Value,
      Multiple
    >;
    type State = BaseSelect.Root.State;
    type Actions = BaseSelect.Root.Actions;
    type ChangeEventReason = BaseSelect.Root.ChangeEventReason;
    type ChangeEventDetails = BaseSelect.Root.ChangeEventDetails;
  }
  namespace Label {
    type State = BaseSelect.Label.State;
    type Props = BaseSelect.Label.Props;
  }
  namespace Trigger {
    type State = BaseSelect.Trigger.State;
    type Props = BaseSelect.Trigger.Props;
  }
  namespace Value {
    type State = BaseSelect.Value.State;
    type Props = BaseSelect.Value.Props;
  }
  namespace Icon {
    type State = BaseSelect.Icon.State;
    type Props = BaseSelect.Icon.Props;
  }
  namespace Portal {
    type State = BaseSelect.Portal.State;
    type Props = BaseSelect.Portal.Props;
  }
  namespace Backdrop {
    type State = BaseSelect.Backdrop.State;
    type Props = BaseSelect.Backdrop.Props;
  }
  namespace Positioner {
    type State = BaseSelect.Positioner.State;
    type Props = BaseSelect.Positioner.Props;
  }
  namespace Popup {
    type Props = BaseSelect.Popup.Props;
    type State = BaseSelect.Popup.State;
  }
  namespace List {
    type Props = BaseSelect.List.Props;
    type State = BaseSelect.List.State;
  }
  namespace Item {
    type State = BaseSelect.Item.State;
    type Props = BaseSelect.Item.Props;
  }
  namespace ItemIndicator {
    type State = BaseSelect.ItemIndicator.State;
    type Props = BaseSelect.ItemIndicator.Props;
  }
  namespace ItemText {
    type State = BaseSelect.ItemText.State;
    type Props = BaseSelect.ItemText.Props;
  }
  namespace Arrow {
    type State = BaseSelect.Arrow.State;
    type Props = BaseSelect.Arrow.Props;
  }
  namespace ScrollDownArrow {
    type State = BaseSelect.ScrollDownArrow.State;
    type Props = BaseSelect.ScrollDownArrow.Props;
  }
  namespace ScrollUpArrow {
    type State = BaseSelect.ScrollUpArrow.State;
    type Props = BaseSelect.ScrollUpArrow.Props;
  }
  namespace Group {
    type State = BaseSelect.Group.State;
    type Props = BaseSelect.Group.Props;
  }
  namespace GroupLabel {
    type State = BaseSelect.GroupLabel.State;
    type Props = BaseSelect.GroupLabel.Props;
  }
  namespace Separator {
    type Props = BaseSelect.Separator.Props;
    type State = BaseSelect.Separator.State;
  }
}

export const Combobox = /* @__PURE__ */ styledParts(BaseCombobox, {
  Label: "combobox-label",
  Value: "combobox-value",
  Input: "combobox-input",
  InputGroup: "combobox-input-group",
  Trigger: "combobox-trigger",
  List: "combobox-list",
  Status: "combobox-status",
  Backdrop: "combobox-backdrop",
  Positioner: "combobox-positioner",
  Popup: "combobox-popup",
  Arrow: "combobox-arrow",
  Icon: "combobox-icon",
  Group: "combobox-group",
  GroupLabel: "combobox-group-label",
  Item: "combobox-item",
  ItemIndicator: "combobox-item-indicator",
  Chips: "combobox-chips",
  Chip: "combobox-chip",
  ChipRemove: "combobox-chip-remove",
  Row: "combobox-row",
  Empty: "combobox-empty",
  Clear: "combobox-clear",
  Separator: "combobox-separator",
  createItems: "combobox-create-items",
});
export declare namespace Combobox {
  namespace Root {
    type Props<
      Value,
      Multiple extends boolean | undefined = false,
      Item = Value,
    > = BaseCombobox.Root.Props<Value, Multiple, Item>;
    type State = BaseCombobox.Root.State;
    type Actions = BaseCombobox.Root.Actions;
    type ChangeEventReason = BaseCombobox.Root.ChangeEventReason;
    type ChangeEventDetails = BaseCombobox.Root.ChangeEventDetails;
    type HighlightEventReason = BaseCombobox.Root.HighlightEventReason;
    type HighlightEventDetails = BaseCombobox.Root.HighlightEventDetails;
  }
  namespace Label {
    type State = BaseCombobox.Label.State;
    type Props = BaseCombobox.Label.Props;
  }
  namespace Value {
    type State = BaseCombobox.Value.State;
    type Props = BaseCombobox.Value.Props;
  }
  namespace Input {
    type State = BaseCombobox.Input.State;
    type Props = BaseCombobox.Input.Props;
  }
  namespace InputGroup {
    type State = BaseCombobox.InputGroup.State;
    type Props = BaseCombobox.InputGroup.Props;
  }
  namespace Trigger {
    type State = BaseCombobox.Trigger.State;
    type Props = BaseCombobox.Trigger.Props;
  }
  namespace List {
    type State = BaseCombobox.List.State;
    type Props = BaseCombobox.List.Props;
  }
  namespace Status {
    type State = BaseCombobox.Status.State;
    type Props = BaseCombobox.Status.Props;
  }
  namespace Portal {
    type State = BaseCombobox.Portal.State;
    type Props = BaseCombobox.Portal.Props;
  }
  namespace Backdrop {
    type Props = BaseCombobox.Backdrop.Props;
    type State = BaseCombobox.Backdrop.State;
  }
  namespace Positioner {
    type State = BaseCombobox.Positioner.State;
    type Props = BaseCombobox.Positioner.Props;
  }
  namespace Popup {
    type State = BaseCombobox.Popup.State;
    type Props = BaseCombobox.Popup.Props;
  }
  namespace Arrow {
    type State = BaseCombobox.Arrow.State;
    type Props = BaseCombobox.Arrow.Props;
  }
  namespace Icon {
    type State = BaseCombobox.Icon.State;
    type Props = BaseCombobox.Icon.Props;
  }
  namespace Group {
    type State = BaseCombobox.Group.State;
    type Props = BaseCombobox.Group.Props;
  }
  namespace GroupLabel {
    type State = BaseCombobox.GroupLabel.State;
    type Props = BaseCombobox.GroupLabel.Props;
  }
  namespace Item {
    type State = BaseCombobox.Item.State;
    type Props = BaseCombobox.Item.Props;
  }
  namespace ItemIndicator {
    type Props = BaseCombobox.ItemIndicator.Props;
    type State = BaseCombobox.ItemIndicator.State;
  }
  namespace Chips {
    type State = BaseCombobox.Chips.State;
    type Props = BaseCombobox.Chips.Props;
  }
  namespace Chip {
    type State = BaseCombobox.Chip.State;
    type Props = BaseCombobox.Chip.Props;
  }
  namespace ChipRemove {
    type State = BaseCombobox.ChipRemove.State;
    type Props = BaseCombobox.ChipRemove.Props;
  }
  namespace Row {
    type State = BaseCombobox.Row.State;
    type Props = BaseCombobox.Row.Props;
  }
  namespace Collection {
    type State = BaseCombobox.Collection.State;
    type Props = BaseCombobox.Collection.Props;
  }
  namespace Empty {
    type State = BaseCombobox.Empty.State;
    type Props = BaseCombobox.Empty.Props;
  }
  namespace Clear {
    type State = BaseCombobox.Clear.State;
    type Props = BaseCombobox.Clear.Props;
  }
  namespace Separator {
    type Props = BaseCombobox.Separator.Props;
    type State = BaseCombobox.Separator.State;
  }
}

export const Tooltip = /* @__PURE__ */ styledParts(BaseTooltip, {
  Trigger: "tooltip-trigger",
  Positioner: "tooltip-positioner",
  Popup: "tooltip-popup",
  Arrow: "tooltip-arrow",
  Viewport: "tooltip-viewport",
});
export declare namespace Tooltip {
  namespace Root {
    type State = BaseTooltip.Root.State;
    type Props<Payload = unknown> = BaseTooltip.Root.Props<Payload>;
    type Actions = BaseTooltip.Root.Actions;
    type ChangeEventReason = BaseTooltip.Root.ChangeEventReason;
    type ChangeEventDetails = BaseTooltip.Root.ChangeEventDetails;
  }
  namespace Trigger {
    type State = BaseTooltip.Trigger.State;
    type Props<Payload = unknown> = BaseTooltip.Trigger.Props<Payload>;
  }
  namespace Portal {
    type State = BaseTooltip.Portal.State;
    type Props = BaseTooltip.Portal.Props;
  }
  namespace Positioner {
    type State = BaseTooltip.Positioner.State;
    type Props = BaseTooltip.Positioner.Props;
  }
  namespace Popup {
    type State = BaseTooltip.Popup.State;
    type Props = BaseTooltip.Popup.Props;
  }
  namespace Arrow {
    type State = BaseTooltip.Arrow.State;
    type Props = BaseTooltip.Arrow.Props;
  }
  namespace Provider {
    type State = BaseTooltip.Provider.State;
    type Props = BaseTooltip.Provider.Props;
  }
  namespace Viewport {
    type Props = BaseTooltip.Viewport.Props;
    type State = BaseTooltip.Viewport.State;
  }
}

export const Autocomplete = /* @__PURE__ */ styledParts(BaseAutocomplete, {
  Trigger: "autocomplete-trigger",
  Input: "autocomplete-input",
  InputGroup: "autocomplete-input-group",
  Icon: "autocomplete-icon",
  Clear: "autocomplete-clear",
  List: "autocomplete-list",
  Status: "autocomplete-status",
  Backdrop: "autocomplete-backdrop",
  Positioner: "autocomplete-positioner",
  Popup: "autocomplete-popup",
  Arrow: "autocomplete-arrow",
  Group: "autocomplete-group",
  GroupLabel: "autocomplete-group-label",
  Item: "autocomplete-item",
  Row: "autocomplete-row",
  Empty: "autocomplete-empty",
  Separator: "autocomplete-separator",
});
export declare namespace Autocomplete {
  namespace Root {
    type Props<ItemValue> = BaseAutocomplete.Root.Props<ItemValue>;
    type State = BaseAutocomplete.Root.State;
    type Actions = BaseAutocomplete.Root.Actions;
    type ChangeEventReason = BaseAutocomplete.Root.ChangeEventReason;
    type ChangeEventDetails = BaseAutocomplete.Root.ChangeEventDetails;
    type HighlightEventReason = BaseAutocomplete.Root.HighlightEventReason;
    type HighlightEventDetails = BaseAutocomplete.Root.HighlightEventDetails;
  }
  namespace Value {
    type State = BaseAutocomplete.Value.State;
    type Props = BaseAutocomplete.Value.Props;
  }
  namespace Trigger {
    type State = BaseAutocomplete.Trigger.State;
    type Props = BaseAutocomplete.Trigger.Props;
  }
  namespace Input {
    type State = BaseAutocomplete.Input.State;
    type Props = BaseAutocomplete.Input.Props;
  }
  namespace InputGroup {
    type State = BaseAutocomplete.InputGroup.State;
    type Props = BaseAutocomplete.InputGroup.Props;
  }
  namespace Icon {
    type State = BaseAutocomplete.Icon.State;
    type Props = BaseAutocomplete.Icon.Props;
  }
  namespace Clear {
    type State = BaseAutocomplete.Clear.State;
    type Props = BaseAutocomplete.Clear.Props;
  }
  namespace List {
    type State = BaseAutocomplete.List.State;
    type Props = BaseAutocomplete.List.Props;
  }
  namespace Status {
    type State = BaseAutocomplete.Status.State;
    type Props = BaseAutocomplete.Status.Props;
  }
  namespace Portal {
    type State = BaseAutocomplete.Portal.State;
    type Props = BaseAutocomplete.Portal.Props;
  }
  namespace Backdrop {
    type Props = BaseAutocomplete.Backdrop.Props;
    type State = BaseAutocomplete.Backdrop.State;
  }
  namespace Positioner {
    type State = BaseAutocomplete.Positioner.State;
    type Props = BaseAutocomplete.Positioner.Props;
  }
  namespace Popup {
    type State = BaseAutocomplete.Popup.State;
    type Props = BaseAutocomplete.Popup.Props;
  }
  namespace Arrow {
    type State = BaseAutocomplete.Arrow.State;
    type Props = BaseAutocomplete.Arrow.Props;
  }
  namespace Group {
    type State = BaseAutocomplete.Group.State;
    type Props = BaseAutocomplete.Group.Props;
  }
  namespace GroupLabel {
    type State = BaseAutocomplete.GroupLabel.State;
    type Props = BaseAutocomplete.GroupLabel.Props;
  }
  namespace Item {
    type State = BaseAutocomplete.Item.State;
    type Props = BaseAutocomplete.Item.Props;
  }
  namespace Row {
    type State = BaseAutocomplete.Row.State;
    type Props = BaseAutocomplete.Row.Props;
  }
  namespace Collection {
    type State = BaseAutocomplete.Collection.State;
    type Props = BaseAutocomplete.Collection.Props;
  }
  namespace Empty {
    type State = BaseAutocomplete.Empty.State;
    type Props = BaseAutocomplete.Empty.Props;
  }
  namespace Separator {
    type Props = BaseAutocomplete.Separator.Props;
    type State = BaseAutocomplete.Separator.State;
  }
}

export const ContextMenu = /* @__PURE__ */ styledParts(BaseContextMenu, {
  Trigger: "context-menu-trigger",
  Backdrop: "context-menu-backdrop",
  Positioner: "context-menu-positioner",
  Popup: "context-menu-popup",
  Arrow: "context-menu-arrow",
  Group: "context-menu-group",
  GroupLabel: "context-menu-group-label",
  Item: "context-menu-item",
  CheckboxItem: "context-menu-checkbox-item",
  CheckboxItemIndicator: "context-menu-checkbox-item-indicator",
  LinkItem: "context-menu-link-item",
  RadioGroup: "context-menu-radio-group",
  RadioItem: "context-menu-radio-item",
  RadioItemIndicator: "context-menu-radio-item-indicator",
  SubmenuRoot: "context-menu-submenu-root",
  SubmenuTrigger: "context-menu-submenu-trigger",
  Separator: "context-menu-separator",
});
export declare namespace ContextMenu {
  namespace Root {
    type State = BaseContextMenu.Root.State;
    type Props = BaseContextMenu.Root.Props;
    type Actions = BaseContextMenu.Root.Actions;
    type ChangeEventReason = BaseContextMenu.Root.ChangeEventReason;
    type ChangeEventDetails = BaseContextMenu.Root.ChangeEventDetails;
  }
  namespace Trigger {
    type State = BaseContextMenu.Trigger.State;
    type Props = BaseContextMenu.Trigger.Props;
  }
  namespace Backdrop {
    type State = BaseContextMenu.Backdrop.State;
    type Props = BaseContextMenu.Backdrop.Props;
  }
  namespace Portal {
    type State = BaseContextMenu.Portal.State;
    type Props = BaseContextMenu.Portal.Props;
  }
  namespace Positioner {
    type Props = BaseContextMenu.Positioner.Props;
    type State = BaseContextMenu.Positioner.State;
  }
  namespace Popup {
    type Props = BaseContextMenu.Popup.Props;
    type State = BaseContextMenu.Popup.State;
  }
  namespace Arrow {
    type State = BaseContextMenu.Arrow.State;
    type Props = BaseContextMenu.Arrow.Props;
  }
  namespace Group {
    type Props = BaseContextMenu.Group.Props;
    type State = BaseContextMenu.Group.State;
  }
  namespace GroupLabel {
    type Props = BaseContextMenu.GroupLabel.Props;
    type State = BaseContextMenu.GroupLabel.State;
  }
  namespace Item {
    type State = BaseContextMenu.Item.State;
    type Props = BaseContextMenu.Item.Props;
  }
  namespace CheckboxItem {
    type State = BaseContextMenu.CheckboxItem.State;
    type Props = BaseContextMenu.CheckboxItem.Props;
    type ChangeEventReason = BaseContextMenu.CheckboxItem.ChangeEventReason;
    type ChangeEventDetails = BaseContextMenu.CheckboxItem.ChangeEventDetails;
  }
  namespace CheckboxItemIndicator {
    type Props = BaseContextMenu.CheckboxItemIndicator.Props;
    type State = BaseContextMenu.CheckboxItemIndicator.State;
  }
  namespace LinkItem {
    type State = BaseContextMenu.LinkItem.State;
    type Props = BaseContextMenu.LinkItem.Props;
  }
  namespace RadioGroup {
    type Props = BaseContextMenu.RadioGroup.Props;
    type State = BaseContextMenu.RadioGroup.State;
    type ChangeEventReason = BaseContextMenu.RadioGroup.ChangeEventReason;
    type ChangeEventDetails = BaseContextMenu.RadioGroup.ChangeEventDetails;
  }
  namespace RadioItem {
    type State = BaseContextMenu.RadioItem.State;
    type Props = BaseContextMenu.RadioItem.Props;
  }
  namespace RadioItemIndicator {
    type Props = BaseContextMenu.RadioItemIndicator.Props;
    type State = BaseContextMenu.RadioItemIndicator.State;
  }
  namespace SubmenuRoot {
    type Props = BaseContextMenu.SubmenuRoot.Props;
    type State = BaseContextMenu.SubmenuRoot.State;
    type ChangeEventReason = BaseContextMenu.SubmenuRoot.ChangeEventReason;
    type ChangeEventDetails = BaseContextMenu.SubmenuRoot.ChangeEventDetails;
  }
  namespace SubmenuTrigger {
    type Props = BaseContextMenu.SubmenuTrigger.Props;
    type State = BaseContextMenu.SubmenuTrigger.State;
  }
  namespace Separator {
    type Props = BaseContextMenu.Separator.Props;
    type State = BaseContextMenu.Separator.State;
  }
}

export const Drawer = /* @__PURE__ */ styledParts(BaseDrawer, {
  Backdrop: "drawer-backdrop",
  Close: "drawer-close",
  Content: "drawer-content",
  Description: "drawer-description",
  Indent: "drawer-indent",
  IndentBackground: "drawer-indent-background",
  Popup: "drawer-popup",
  SwipeArea: "drawer-swipe-area",
  Title: "drawer-title",
  Trigger: "drawer-trigger",
  Viewport: "drawer-viewport",
});
export declare namespace Drawer {
  namespace Backdrop {
    type Props = BaseDrawer.Backdrop.Props;
    type State = BaseDrawer.Backdrop.State;
  }
  namespace Close {
    type Props = BaseDrawer.Close.Props;
    type State = BaseDrawer.Close.State;
  }
  namespace Content {
    type Props = BaseDrawer.Content.Props;
    type State = BaseDrawer.Content.State;
  }
  namespace Description {
    type Props = BaseDrawer.Description.Props;
    type State = BaseDrawer.Description.State;
  }
  namespace Indent {
    type State = BaseDrawer.Indent.State;
    type Props = BaseDrawer.Indent.Props;
  }
  namespace IndentBackground {
    type State = BaseDrawer.IndentBackground.State;
    type Props = BaseDrawer.IndentBackground.Props;
  }
  namespace Popup {
    type Props = BaseDrawer.Popup.Props;
    type State = BaseDrawer.Popup.State;
  }
  namespace Portal {
    type Props = BaseDrawer.Portal.Props;
    type State = BaseDrawer.Portal.State;
  }
  namespace Provider {
    type State = BaseDrawer.Provider.State;
    type Props = BaseDrawer.Provider.Props;
  }
  namespace Root {
    type State = BaseDrawer.Root.State;
    type Props<Payload = unknown> = BaseDrawer.Root.Props<Payload>;
    type Actions = BaseDrawer.Root.Actions;
    type ChangeEventReason = BaseDrawer.Root.ChangeEventReason;
    type ChangeEventDetails = BaseDrawer.Root.ChangeEventDetails;
    type SnapPointChangeEventReason = BaseDrawer.Root.SnapPointChangeEventReason;
    type SnapPointChangeEventDetails = BaseDrawer.Root.SnapPointChangeEventDetails;
    type SnapPoint = BaseDrawer.Root.SnapPoint;
  }
  namespace SwipeArea {
    type Props = BaseDrawer.SwipeArea.Props;
    type State = BaseDrawer.SwipeArea.State;
  }
  namespace Title {
    type Props = BaseDrawer.Title.Props;
    type State = BaseDrawer.Title.State;
  }
  namespace Trigger {
    type Props<Payload = unknown> = BaseDrawer.Trigger.Props<Payload>;
    type State = BaseDrawer.Trigger.State;
  }
  namespace Viewport {
    type Props = BaseDrawer.Viewport.Props;
    type State = BaseDrawer.Viewport.State;
  }
  namespace VirtualKeyboardProvider {
    type State = BaseDrawer.VirtualKeyboardProvider.State;
    type Props = BaseDrawer.VirtualKeyboardProvider.Props;
  }
}

export const NavigationMenu = /* @__PURE__ */ styledParts(BaseNavigationMenu, {
  Root: "navigation-menu-root",
  List: "navigation-menu-list",
  Item: "navigation-menu-item",
  Content: "navigation-menu-content",
  Trigger: "navigation-menu-trigger",
  Positioner: "navigation-menu-positioner",
  Viewport: "navigation-menu-viewport",
  Backdrop: "navigation-menu-backdrop",
  Popup: "navigation-menu-popup",
  Arrow: "navigation-menu-arrow",
  Link: "navigation-menu-link",
  Icon: "navigation-menu-icon",
});
export declare namespace NavigationMenu {
  namespace Root {
    type State = BaseNavigationMenu.Root.State;
    type Props<TValue = any> = BaseNavigationMenu.Root.Props<TValue>;
    type Value<TValue = any> = BaseNavigationMenu.Root.Value<TValue>;
    type Actions = BaseNavigationMenu.Root.Actions;
    type ChangeEventReason = BaseNavigationMenu.Root.ChangeEventReason;
    type ChangeEventDetails = BaseNavigationMenu.Root.ChangeEventDetails;
  }
  namespace List {
    type State = BaseNavigationMenu.List.State;
    type Props = BaseNavigationMenu.List.Props;
  }
  namespace Item {
    type State = BaseNavigationMenu.Item.State;
    type Props = BaseNavigationMenu.Item.Props;
  }
  namespace Content {
    type State = BaseNavigationMenu.Content.State;
    type Props = BaseNavigationMenu.Content.Props;
  }
  namespace Trigger {
    type State = BaseNavigationMenu.Trigger.State;
    type Props = BaseNavigationMenu.Trigger.Props;
  }
  namespace Portal {
    type State = BaseNavigationMenu.Portal.State;
    type Props = BaseNavigationMenu.Portal.Props;
  }
  namespace Positioner {
    type State = BaseNavigationMenu.Positioner.State;
    type Props = BaseNavigationMenu.Positioner.Props;
  }
  namespace Viewport {
    type State = BaseNavigationMenu.Viewport.State;
    type Props = BaseNavigationMenu.Viewport.Props;
  }
  namespace Backdrop {
    type State = BaseNavigationMenu.Backdrop.State;
    type Props = BaseNavigationMenu.Backdrop.Props;
  }
  namespace Popup {
    type State = BaseNavigationMenu.Popup.State;
    type Props = BaseNavigationMenu.Popup.Props;
  }
  namespace Arrow {
    type State = BaseNavigationMenu.Arrow.State;
    type Props = BaseNavigationMenu.Arrow.Props;
  }
  namespace Link {
    type State = BaseNavigationMenu.Link.State;
    type Props = BaseNavigationMenu.Link.Props;
  }
  namespace Icon {
    type State = BaseNavigationMenu.Icon.State;
    type Props = BaseNavigationMenu.Icon.Props;
  }
}

export const PreviewCard = /* @__PURE__ */ styledParts(BasePreviewCard, {
  Trigger: "preview-card-trigger",
  Positioner: "preview-card-positioner",
  Popup: "preview-card-popup",
  Arrow: "preview-card-arrow",
  Backdrop: "preview-card-backdrop",
  Viewport: "preview-card-viewport",
});
export declare namespace PreviewCard {
  namespace Root {
    type State = BasePreviewCard.Root.State;
    type Props<Payload = unknown> = BasePreviewCard.Root.Props<Payload>;
    type Actions = BasePreviewCard.Root.Actions;
    type ChangeEventReason = BasePreviewCard.Root.ChangeEventReason;
    type ChangeEventDetails = BasePreviewCard.Root.ChangeEventDetails;
  }
  namespace Portal {
    type State = BasePreviewCard.Portal.State;
    type Props = BasePreviewCard.Portal.Props;
  }
  namespace Trigger {
    type State = BasePreviewCard.Trigger.State;
    type Props<Payload = unknown> = BasePreviewCard.Trigger.Props<Payload>;
  }
  namespace Positioner {
    type State = BasePreviewCard.Positioner.State;
    type Props = BasePreviewCard.Positioner.Props;
  }
  namespace Popup {
    type State = BasePreviewCard.Popup.State;
    type Props = BasePreviewCard.Popup.Props;
  }
  namespace Arrow {
    type State = BasePreviewCard.Arrow.State;
    type Props = BasePreviewCard.Arrow.Props;
  }
  namespace Backdrop {
    type State = BasePreviewCard.Backdrop.State;
    type Props = BasePreviewCard.Backdrop.Props;
  }
  namespace Viewport {
    type Props = BasePreviewCard.Viewport.Props;
    type State = BasePreviewCard.Viewport.State;
  }
}
