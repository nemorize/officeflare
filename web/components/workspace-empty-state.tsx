import type { ReactNode } from "react";
import { Icon, type IconProps } from "./ui";
import "./workspace-empty-state.css";

export function WorkspaceEmptyState({
  icon,
  title,
  description,
  children,
  className = "",
}: {
  icon: IconProps["name"];
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`workspace-empty-state ${className}`.trim()}>
      <div className="workspace-empty-state-art" aria-hidden="true">
        <span />
        <Icon name={icon} width="54" height="54" />
        <span />
      </div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
