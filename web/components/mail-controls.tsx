import { t } from "../../shared/i18n/index.ts";
import type { ReactNode, ComponentProps } from "react";
import { Button, Icon, Menu, MenuPopup, type IconProps } from "./ui";
export { WorkspaceIconButton as MailIconButton } from "./workspace-controls";
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
