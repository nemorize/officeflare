import type { ReactNode } from "react";
import { Field } from "./styled-primitives";
import { Input, type InputProps } from "./input";

export interface TextFieldProps extends InputProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  fieldProps?: Omit<Field.Root.Props, "children" | "name" | "disabled">;
}

export function TextField({ label, description, error, fieldProps, name, disabled, ...inputProps }: TextFieldProps) {
  return (
    <Field.Root data-ui="text-field" {...fieldProps} name={name} disabled={disabled}
      invalid={error ? true : fieldProps?.invalid}>
      <Field.Label>{label}</Field.Label>
      {" "}
      <Input {...inputProps} />
      {description && <Field.Description>{description}</Field.Description>}
      <Field.Error match={error ? true : undefined}>{error}</Field.Error>
    </Field.Root>
  );
}
