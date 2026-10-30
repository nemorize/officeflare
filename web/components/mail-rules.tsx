import { enumLabel } from "../../shared/i18n/labels.ts";
import { LocalizedMessage } from "./i18n";
import { t } from "../../shared/i18n/index.ts";
import { useState } from "react";
import { api } from "../lib/api";
import { type Condition, type Folder, type MailRule, type RuleAction } from "../lib/mail";
import { Button } from "./ui";
import { Check, Confirm } from "./console-shared";
import {
  MailField,
  MailInput,
  MailModal,
  MailNotice,
  MailSection,
  MailState,
  useMailAction,
  useMailResource,
  MailForm,
  MailFieldset,
  MailSelect,
} from "./mail-common";
export function MailRules({
  path,
  folders = [],
  canManage,
  routing = false,
}: {
  path: string;
  folders?: Folder[];
  canManage: boolean;
  routing?: boolean;
}) {
  const resource = useMailResource<{ rules: MailRule[] }>(path),
    [editing, setEditing] = useState<MailRule | "new" | null>(null),
    [deleting, setDeleting] = useState<MailRule | null>(null);
  return (
    <MailSection
      title={
        routing ? t("componentsMailRules.inboundRoutingRules") : t("componentsMailRules.inboxRules")
      }
      description={
        routing
          ? t("componentsMailRules.conditionsMustAllMatchHigherPrioritiesRunFirstForward")
          : t("componentsMailRules.conditionsMustAllMatchRulesRunFromHighestTo")
      }
      action={
        canManage && (
          <Button onClick={() => setEditing("new")}>{t("componentsMailRules.addRule")}</Button>
        )
      }
    >
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      {!resource.loading && !resource.data?.rules.length && (
        <p className="mail-hint">{t("componentsMailRules.noRulesConfigured")}</p>
      )}
      <div className="mail-record-list">
        {resource.data?.rules.map((rule) => (
          <div className="mail-record" key={rule.id}>
            <div>
              <strong>{rule.name}</strong>
              <p>
                <span className="mail-badge">
                  {rule.enabled ? t("common.enabled") : t("common.disabled")}
                </span>
                <LocalizedMessage
                  id="componentsMailRules.priority"
                  values={{
                    priority: rule.priority,
                    value2: routing && ` · ${enumLabel(rule.action)}`,
                  }}
                />
              </p>
              <RuleSummary rule={rule} folders={folders} />
            </div>
            {canManage && (
              <div className="mail-actions">
                <Button size="sm" onClick={() => setEditing(rule)}>
                  {t("common.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(rule)}>
                  {t("common.delete")}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <RuleEditor
          key={editing === "new" ? "new" : editing.id}
          path={path}
          folders={folders}
          routing={routing}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={resource.reload}
        />
      )}
      <Confirm
        open={!!deleting}
        title={t("componentsMailRules.deleteRule")}
        description={t("componentsMailRules.willStopApplyingToIncomingMail", {
          value1: deleting?.name ?? "",
        })}
        label={t("componentsMailRules.deleteRule2")}
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await api(`${path}/${deleting!.id}`, { method: "DELETE" });
          resource.reload();
        }}
      />
    </MailSection>
  );
}
function RuleSummary({ rule, folders }: { rule: MailRule; folders: Folder[] }) {
  try {
    const conditions = JSON.parse(rule.conditions_json) as Condition[],
      actions = JSON.parse(rule.actions_json ?? "[]") as RuleAction[];
    return (
      <p className="mail-hint">
        {conditions
          .map((condition) => `${condition.field} ${condition.operator} “${condition.value}”`)
          .join(" · ")}
        {actions.length
          ? ` → ${actions.map((action) => (action.type === "move" ? t("componentsMailRules.moveTo", { value1: folders.find((folder) => folder.id === action.folder_id)?.name ?? action.folder_id ?? t("componentsMailRules.folder") }) : action.type)).join(", ")}`
          : ""}
      </p>
    );
  } catch {
    return <p className="mail-hint">{t("componentsMailRules.unableToDisplayRuleDetails")}</p>;
  }
}
function RuleEditor({
  path,
  folders,
  existing,
  routing,
  onClose,
  onSaved,
}: {
  path: string;
  folders: Folder[];
  existing?: MailRule;
  routing: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const action = useMailAction(),
    [name, setName] = useState(existing?.name ?? ""),
    [priority, setPriority] = useState(existing?.priority ?? 0),
    [enabled, setEnabled] = useState(existing ? !!existing.enabled : true);
  const [conditions, setConditions] = useState<Condition[]>(
      existing
        ? JSON.parse(existing.conditions_json)
        : [{ field: "from", operator: "contains", value: "" }],
    ),
    [actions, setActions] = useState<RuleAction[]>(
      existing?.actions_json
        ? JSON.parse(existing.actions_json)
        : [{ type: "move", folder_id: "inbox" }],
    );
  const [routingAction, setRoutingAction] = useState(existing?.action ?? "store"),
    [forwardTo, setForwardTo] = useState(existing?.forward_to ?? ""),
    [rejectReason, setRejectReason] = useState(existing?.reject_reason ?? "");
  const updateCondition = (index: number, patch: Partial<Condition>) =>
    setConditions(
      conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    );
  return (
    <MailModal
      open
      title={existing ? t("componentsMailRules.editRule") : t("componentsMailRules.newRule")}
      description={
        routing
          ? t("componentsMailRules.routeMatchingMailBeforeItReachesAMailbox")
          : t("componentsMailRules.applyActionsToIncomingMessagesThatMatchEveryCondition")
      }
      onClose={onClose}
      busy={action.busy}
      wide
    >
      <MailForm
        className="mail-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const body = {
              name,
              priority,
              enabled,
              conditions,
              ...(existing ? { id: existing.id, version: existing.version } : {}),
              ...(routing
                ? {
                    action: routingAction,
                    ...(routingAction === "forward" ? { forward_to: forwardTo } : {}),
                    ...(routingAction === "reject" && rejectReason
                      ? { reject_reason: rejectReason }
                      : {}),
                  }
                : {
                    actions: actions.map((value) =>
                      value.type === "move" ? value : { type: value.type },
                    ),
                  }),
            };
            await api(path, { method: "POST", body });
            onSaved();
            onClose();
          });
        }}
      >
        <MailFieldset disabled={action.busy}>
          <div className="mail-form-grid">
            <MailInput
              label={t("componentsMailRules.ruleName")}
              value={name}
              maxLength={100}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <MailInput
              label={t("componentsMailRules.priority2")}
              type="number"
              min={-1000}
              max={1000}
              required
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
            />
          </div>
          <Check checked={enabled} onChange={setEnabled}>
            {t("componentsMailRules.enableRule")}
          </Check>
          <h3>{t("componentsMailRules.whenAllOfTheseMatch")}</h3>
          <div className="mail-rule-conditions">
            {conditions.map((condition, index) => (
              <div className="mail-rule-row" key={index}>
                <MailField label={t("componentsMailRules.field", { value1: index + 1 })}>
                  <MailSelect
                    value={condition.field}
                    onValueChange={(nextValue) => updateCondition(index, { field: nextValue })}
                    options={[
                      ...((routing
                        ? ["from", "to", "subject"]
                        : ["from", "to", "subject", "body"]
                      ).map((field) => ({
                        value: field,
                        label:
                          field === "from"
                            ? t("componentsMailRules.sender")
                            : field === "to"
                              ? t("componentsMailRules.recipient")
                              : field === "subject"
                                ? t("componentsMailRules.subject")
                                : t("componentsMailRules.body"),
                      })) || []),
                    ]}
                  />
                </MailField>
                <MailField label={t("componentsMailRules.match")}>
                  <MailSelect
                    value={condition.operator}
                    onValueChange={(nextValue) => updateCondition(index, { operator: nextValue })}
                    options={[
                      ...(["contains", "equals", "prefix", "suffix"].map((operator) => ({
                        value: operator,
                        label:
                          operator === "prefix"
                            ? t("componentsMailRules.startsWith")
                            : operator === "suffix"
                              ? t("componentsMailRules.endsWith")
                              : operator,
                      })) || []),
                    ]}
                  />
                </MailField>
                <MailInput
                  label={t("componentsMailRules.value")}
                  value={condition.value}
                  required
                  maxLength={1000}
                  onChange={(event) => updateCondition(index, { value: event.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("componentsMailRules.removeCondition", { value1: index + 1 })}
                  disabled={conditions.length === 1}
                  onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                >
                  {t("componentsMailRules.text")}
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            disabled={conditions.length >= 20}
            onClick={() =>
              setConditions([...conditions, { field: "subject", operator: "contains", value: "" }])
            }
          >
            {t("componentsMailRules.addCondition")}
          </Button>
          <h3>{t("componentsMailRules.then")}</h3>
          {routing ? (
            <>
              <MailField label={t("componentsMailRules.routingAction")}>
                <MailSelect
                  value={routingAction}
                  onValueChange={(nextValue) => setRoutingAction(nextValue)}
                  options={[
                    { value: "store", label: t("componentsMailRules.storeInMailbox") },
                    { value: "forward", label: t("componentsMailRules.forwardToVerifiedAddress") },
                    { value: "reject", label: t("componentsMailRules.rejectMessage") },
                  ]}
                />
              </MailField>
              {routingAction === "forward" && (
                <MailInput
                  label={t("componentsMailRules.verifiedForwardingAddress")}
                  type="email"
                  value={forwardTo}
                  required
                  onChange={(event) => setForwardTo(event.target.value)}
                />
              )}
              {routingAction === "reject" && (
                <MailInput
                  label={t("componentsMailRules.rejectionReasonOptional")}
                  maxLength={200}
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                />
              )}
            </>
          ) : (
            <>
              {actions.map((value, index) => (
                <div className="mail-rule-action" key={index}>
                  <MailField label={t("componentsMailRules.action", { value1: index + 1 })}>
                    <MailSelect
                      value={value.type}
                      onValueChange={(nextValue) =>
                        setActions(
                          actions.map((old, i) =>
                            i === index
                              ? {
                                  type: nextValue,
                                  ...(nextValue === "move" ? { folder_id: "inbox" } : {}),
                                }
                              : old,
                          ),
                        )
                      }
                      options={[
                        { value: "move", label: t("componentsMailRules.moveToFolder") },
                        { value: "star", label: t("componentsMailRules.star") },
                        { value: "read", label: t("componentsMailRules.markRead") },
                        { value: "spam", label: t("componentsMailRules.markSpam") },
                      ]}
                    />
                  </MailField>
                  {value.type === "move" && (
                    <MailField label={t("componentsMailRules.folder")}>
                      <MailSelect
                        value={value.folder_id}
                        onValueChange={(nextValue) =>
                          setActions(
                            actions.map((old, i) =>
                              i === index ? { ...old, folder_id: nextValue } : old,
                            ),
                          )
                        }
                        options={[
                          ...(folders
                            .filter(
                              (folder) => !["drafts", "sent"].includes(folder.system_key ?? ""),
                            )
                            .map((folder) => ({ value: folder.id, label: folder.name })) || []),
                        ]}
                      />
                    </MailField>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("componentsMailRules.removeAction", { value1: index + 1 })}
                    disabled={actions.length === 1}
                    onClick={() => setActions(actions.filter((_, i) => i !== index))}
                  >
                    {t("componentsMailRules.text")}
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                disabled={actions.length >= 10}
                onClick={() => setActions([...actions, { type: "read" }])}
              >
                {t("componentsMailRules.addAction")}
              </Button>
            </>
          )}
        </MailFieldset>
        <MailNotice error={action.error} />
        <div className="mail-actions">
          <Button onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.busy}>
            {action.busy ? t("common.saving") : t("componentsMailRules.saveRule")}
          </Button>
        </div>
      </MailForm>
    </MailModal>
  );
}
