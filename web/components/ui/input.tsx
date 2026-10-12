import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentPropsWithRef } from "react";

export interface InputProps extends ComponentPropsWithRef<typeof BaseInput> {
  font?: "default" | "mono";
  variant?: "outline" | "integrated";
}

export function Input({ variant = "outline", font = "default", ...props }: InputProps) {
  return <BaseInput data-ui="input" data-variant={variant} data-font={font} {...props} />;
}
