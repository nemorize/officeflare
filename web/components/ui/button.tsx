import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithRef } from "react";

export interface ButtonProps extends ComponentPropsWithRef<typeof BaseButton> {
  variant?: "primary" | "secondary" | "ghost" | "subtle" | "danger";
  size?: "sm" | "md" | "icon";
}

// React 19 passes ref as a prop; keep render, events and state callbacks intact.
export function Button({ variant = "secondary", size = "md", ...props }: ButtonProps) {
  return <BaseButton data-ui="button" data-ui-button="" data-variant={variant} data-size={size} {...props} />;
}
