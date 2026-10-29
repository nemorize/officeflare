import { useState } from "react";
import { Button, TextField } from "./ui";
import { Check } from "./console-shared";
import {
  canGrant,
  defaultEligible,
  permissionCatalog,
  permissionGroups,
  togglePermission,
} from "../lib/console";
import type { PermissionDefinition } from "../../src/authorization/permissions.ts";

export function PermissionPicker({
  selected,
  onChange,
  editable = false,
  owned = [],
  busy = false,
  defaultOnly = false,
  keys,
}: {
  selected: string[];
  onChange?: (permissions: string[]) => void;
  editable?: boolean;
  owned?: string[];
  busy?: boolean;
  defaultOnly?: boolean;
  keys?: readonly string[];
}) {
  const [query, setQuery] = useState("");
  const definitions = Object.entries(permissionCatalog)
    .filter(([key]) => !keys || keys.includes(key))
    .map(([key, definition]) => ({ key, ...(definition as PermissionDefinition) }));
  const needle = query.trim().toLowerCase();
  const allowed = (key: string) =>
    canGrant(owned, [key]) && (!defaultOnly || defaultEligible([key]));
  const visible = definitions.filter((item) =>
    `${item.label} ${item.description} ${item.key}`.toLowerCase().includes(needle),
  );
  return (
    <div className="console-permission-picker">
      <TextField
        label="Find permissions"
        name="permission_search"
        type="search"
        value={query}
        onValueChange={setQuery}
        placeholder="Search by action or service"
      />
      <p className="console-subtext">
        {selected.length} permissions selected · Service and administration permissions apply across
        this workspace. Mailbox and Drive item sharing are checked separately. Drive administration
        does not grant file content access.
      </p>
      {defaultOnly && (
        <p className="console-subtext">
          Default roles can grant service access only. Remove the default setting before adding
          administrative permissions.
        </p>
      )}
      <div className="console-permissions">
        {Object.entries(permissionGroups).map(([group, title]) => {
          const rows = visible.filter((item) => item.group === group),
            all = definitions.filter((item) => item.group === group);
          if (!rows.length) return null;
          return (
            <fieldset key={group}>
              <legend>
                <span>{title}</span>
                <span className="console-subtext">
                  {all.filter((item) => selected.includes(item.key)).length} / {all.length}
                </span>
              </legend>
              {editable && (
                <div className="console-permission-group-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={
                      busy ||
                      !rows.some((item) => !selected.includes(item.key) && allowed(item.key))
                    }
                    onClick={() => {
                      let next = selected;
                      for (const item of rows)
                        if (allowed(item.key)) next = togglePermission(next, item.key, true);
                      onChange?.(next);
                    }}
                  >
                    Select available
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || !rows.some((item) => selected.includes(item.key))}
                    onClick={() => {
                      let next = selected;
                      for (const item of rows) next = togglePermission(next, item.key, false);
                      onChange?.(next);
                    }}
                  >
                    Clear group
                  </Button>
                </div>
              )}
              {rows.map((item) => (
                <Check
                  key={item.key}
                  checked={selected.includes(item.key)}
                  disabled={busy || !editable || !allowed(item.key)}
                  onChange={(checked) => onChange?.(togglePermission(selected, item.key, checked))}
                >
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                  {!!item.requires.length && (
                    <small>
                      Requires:{" "}
                      {item.requires
                        .map(
                          (key) => permissionCatalog[key as keyof typeof permissionCatalog].label,
                        )
                        .join(", ")}
                    </small>
                  )}
                  {item.impact && (
                    <small className="console-permission-impact">{item.impact}</small>
                  )}
                  {editable && !canGrant(owned, [item.key]) && (
                    <small>You do not hold all permissions required to grant this action.</small>
                  )}
                  <code className="console-permission-key">{item.key}</code>
                </Check>
              ))}
            </fieldset>
          );
        })}
        {!visible.length && <p className="console-empty">No matching permissions.</p>}
      </div>
    </div>
  );
}
