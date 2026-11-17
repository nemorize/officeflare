import type { ReactNode } from "react";
import { Icon, type IconProps } from "./ui";
import "./workspace-empty-state.css";

export function WorkspaceEmptyState({
  icon,
  title,
  description,
  children,
  className = "",
  iconBackground = false,
}: {
  icon: IconProps["name"];
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  iconBackground?: boolean;
}) {
  return (
    <div className={`workspace-empty-state ${className}`.trim()}>
      <div
        className="workspace-empty-state-art"
        data-icon-background={iconBackground || undefined}
        aria-hidden="true"
      >
        <Icon name={icon} width={28} height={28} />
      </div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
