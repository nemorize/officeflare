import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithRef } from "react";

export type ButtonProps = ComponentPropsWithRef<typeof BaseButton>;

// React 19 passes ref as a prop; keep render, events and state callbacks intact.
export function Button(props: ButtonProps) {
  return <BaseButton data-ui="button" {...props} />;
}
