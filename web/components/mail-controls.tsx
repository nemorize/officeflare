import { t } from "../../shared/i18n/index.ts";
import type { ReactNode, ComponentProps } from "react";
import { Button, Icon, Tooltip, TooltipPopup, Menu, MenuPopup, type IconProps } from "./ui";
export function MailIconButton({
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
export function MailMenu({
  label = t("componentsMailControls.moreActions"),
  icon = "more",
  children,
  variant = "ghost",
}: {
  variant?: ComponentProps<typeof Button>["variant"];
  label?: string;
  icon?: IconProps["name"];
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="icon" variant={variant} aria-label={label} />}>
        <Icon name={icon} />
      </Menu.Trigger>
      <MenuPopup className="mail-action-menu">{children}</MenuPopup>
    </Menu.Root>
  );
}
