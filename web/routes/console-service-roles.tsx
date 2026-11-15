import { useEffect, useState } from "react";
import { Link } from "react-router";
import { t } from "../../shared/i18n/index.ts";
import { api, errorMessage } from "../lib/api";
import {
  allRoles,
  permissionCatalog,
  servicePermissions,
  serviceRoles,
  type ConsoleRoleService,
  type Role,
} from "../lib/console";
import { useAccess } from "../components/console-access";
import {
  ConsoleSection,
  ConsoleSettingsHeader,
  ConsoleState,
} from "../components/console-settings";
import { Button, Icon } from "../components/ui";
import "./console.css";

export function ServiceRolesConsolePage({ service }: { service: ConsoleRoleService }) {
  const access = useAccess();
  const [roles, setRoles] = useState<Role[] | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRoles(null);
    setError("");
    void allRoles(api, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRoles(serviceRoles(result, service));
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [service, revision]);
  return (
    <section className="account-page console-page console-settings" data-ui-theme="neutral">
      <ConsoleSettingsHeader
        title={service === "wiki" ? t("wiki.title") : t("contacts.title")}
        description={
          service === "wiki"
            ? t("consoleServiceRoles.wikiHint")
            : t("consoleServiceRoles.contactsHint")
        }
      >
        {access.permissions.includes("admin.roles.create") && (
          <Button nativeButton={false} render={<Link to="/console/roles/new" />} variant="primary">
            <Icon name="plus" />
            {t("routesConsoleRoles.newRole")}
          </Button>
        )}
      </ConsoleSettingsHeader>
      <ConsoleState
        loading={!roles}
        error={error}
        retry={() => setRevision((value) => value + 1)}
        kind="list"
      />
      {roles && (
        <ConsoleSection title={t("consoleServiceRoles.accessRoles")}>
          <div
            className="console-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("consoleServiceRoles.accessRoles")}
          >
            <table className="console-table console-settings-table console-service-roles-table">
              <thead>
                <tr>
                  <th scope="col">{t("routesConsoleRoles.role")}</th>
                  <th scope="col">{t("routesConsoleRoles.permissions")}</th>
                  <th scope="col">{t("routesConsoleRoles.users")}</th>
                  <th scope="col">{t("routesConsoleRoles.newUsers")}</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>
                      <Link to={`/console/roles/${encodeURIComponent(role.id)}`}>{role.label}</Link>
                      {role.is_system && (
                        <small className="console-subtext">{t("routesConsoleRoles.system")}</small>
                      )}
                    </td>
                    <td>
                      {servicePermissions(role.permissions, service)
                        .map((key) => permissionCatalog[key].label)
                        .join(", ")}
                    </td>
                    <td>{role.assigned_user_count ?? 0}</td>
                    <td>
                      {role.is_default ? (
                        <span className="console-badge">{t("routesConsoleRoles.default")}</span>
                      ) : (
                        <span className="console-subtext">{t("routesConsoleRoles.optional")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!roles.length && <p className="console-empty">{t("consoleServiceRoles.noRoles")}</p>}
          </div>
        </ConsoleSection>
      )}
    </section>
  );
}
