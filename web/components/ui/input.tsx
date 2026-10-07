import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentPropsWithRef } from "react";

export type InputProps = ComponentPropsWithRef<typeof BaseInput>;

export function Input(props: InputProps) {
  return <BaseInput data-ui="input" {...props} />;
}
