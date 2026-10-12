import type { ComponentPropsWithRef, ReactNode } from "react";
import { Checkbox, Field, Form } from "./styled-primitives";
import { Select, SelectPopup } from "./select";
import { Icon } from "./icon";

export interface CheckboxControlProps extends Checkbox.Root.Props {
  hitArea?: boolean;
}

export function CheckboxControl({ hitArea = false, ...props }: CheckboxControlProps) {
  const control = <Checkbox.Root {...props}>
    <Checkbox.Indicator aria-hidden="true">
      <Icon name={props.indeterminate ? "minimize" : "check"} width="12" height="12" />
    </Checkbox.Indicator>
  </Checkbox.Root>;
  return hitArea ? <label data-ui="checkbox-hit-area" data-disabled={props.disabled || undefined}>{control}</label> : control;
}

export function CheckboxLabel(props: ComponentPropsWithRef<"label">) {
  return <label data-ui="checkbox-label" {...props} />;
}

export interface SelectControlProps {
  options: readonly { value: string; label: ReactNode; disabled?: boolean }[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  variant?: "outline" | "integrated";
  theme?: "neutral";
}

export function SelectControl({ options, value, onValueChange, className, id, name, disabled, required, variant = "outline", theme, "aria-label": ariaLabel }: SelectControlProps) {
  return <Select.Root items={options} value={value} name={name} disabled={disabled} required={required} onValueChange={(next) => onValueChange(next ?? "")}>
    <Select.Trigger className={className} id={id} aria-label={ariaLabel} data-variant={variant} data-ui-theme={theme}>
      <Select.Value />
      <Icon name="down" width="12" height="12" />
    </Select.Trigger>
    <SelectPopup data-ui-theme={theme}><Select.List>{options.map((option) => <Select.Item key={option.value} value={option.value} disabled={option.disabled}>
      <Select.ItemText>{option.label}</Select.ItemText>
      <Select.ItemIndicator><Icon name="check" width="12" height="12" /></Select.ItemIndicator>
    </Select.Item>)}</Select.List></SelectPopup>
  </Select.Root>;
}

export interface TextareaProps extends ComponentPropsWithRef<"textarea"> {
  variant?: "outline" | "integrated";
}

export function Textarea({ variant = "outline", value, disabled, ...props }: TextareaProps) {
  return <Field.Control data-ui="input" data-variant={variant} value={value} disabled={disabled} render={<textarea {...props} />} />;
}

export function SearchField(props: Form.Props) {
  return <Form data-ui="search-field" role="search" {...props} />;
}

export function Snackbar(props: ComponentPropsWithRef<"div">) {
  return <div data-ui="snackbar" role="status" {...props} />;
}

export function ButtonGroup(props: ComponentPropsWithRef<"div">) {
  return <div data-ui="button-group" {...props} />;
}

export function Chip(props: ComponentPropsWithRef<"span"> & { invalid?: boolean }) {
  const { invalid, ...rest } = props;
  return <span data-ui="chip" data-invalid={invalid || undefined} {...rest} />;
}
