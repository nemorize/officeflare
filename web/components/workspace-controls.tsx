import type { ComponentProps } from "react";
import { Button, Icon, Tooltip, TooltipPopup, type IconProps } from "./ui";

export function WorkspaceCreateButton({
  label,
  dropdown = false,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "variant" | "size"> & {
  label: string;
  dropdown?: boolean;
}) {
  return (
    <Button
      {...props}
      variant="primary"
      size="lg"
      className={`workspace-create-button ${className}`.trim()}
    >
      <Icon name="plus" />
      <span>{label}</span>
      {dropdown && <Icon name="down" width="12" height="12" />}
    </Button>
  );
}

export function WorkspaceIconButton({
  icon,
  label,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  icon: IconProps["name"];
  label: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<Button size="icon" variant="ghost" aria-label={label} {...props} />}
      >
        <Icon name={icon} />
      </Tooltip.Trigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip.Root>
  );
}
