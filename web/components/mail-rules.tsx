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
      title={routing ? "Inbound routing rules" : "Inbox rules"}
      description={
        routing
          ? "Conditions must all match. Higher priorities run first. Forward destinations must be verified in Cloudflare."
          : "Conditions must all match. Rules run from highest to lowest priority and are shared by the mailbox."
      }
      action={canManage && <Button onClick={() => setEditing("new")}>Add rule</Button>}
    >
      <MailState
        loading={resource.loading && !resource.data}
        error={resource.error}
        retry={resource.reload}
      />
      {!resource.loading && !resource.data?.rules.length && (
        <p className="mail-hint">No rules configured.</p>
      )}
      <div className="mail-record-list">
        {resource.data?.rules.map((rule) => (
          <div className="mail-record" key={rule.id}>
            <div>
              <strong>{rule.name}</strong>
              <p>
                <span className="mail-badge">{rule.enabled ? "Enabled" : "Disabled"}</span> Priority{" "}
                {rule.priority}
                {routing && ` · ${rule.action}`}
              </p>
              <RuleSummary rule={rule} folders={folders} />
            </div>
            {canManage && (
              <div className="mail-actions">
                <Button size="sm" onClick={() => setEditing(rule)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(rule)}>
                  Delete
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
        title="Delete rule?"
        description={`“${deleting?.name ?? ""}” will stop applying to incoming mail.`}
        label="Delete rule"
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
          ? ` → ${actions.map((action) => (action.type === "move" ? `Move to ${folders.find((folder) => folder.id === action.folder_id)?.name ?? action.folder_id}` : action.type)).join(", ")}`
          : ""}
      </p>
    );
  } catch {
    return <p className="mail-hint">Unable to display rule details.</p>;
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
      title={existing ? "Edit rule" : "New rule"}
      description={
        routing
          ? "Route matching mail before it reaches a mailbox."
          : "Apply actions to incoming messages that match every condition."
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
              label="Rule name"
              value={name}
              maxLength={100}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <MailInput
              label="Priority"
              type="number"
              min={-1000}
              max={1000}
              required
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
            />
          </div>
          <Check checked={enabled} onChange={setEnabled}>
            Enable rule
          </Check>
          <h3>When all of these match</h3>
          <div className="mail-rule-conditions">
            {conditions.map((condition, index) => (
              <div className="mail-rule-row" key={index}>
                <MailField label={`Field ${index + 1}`}>
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
                            ? "Sender"
                            : field === "to"
                              ? "Recipient"
                              : field === "subject"
                                ? "Subject"
                                : "Body",
                      })) || []),
                    ]}
                  />
                </MailField>
                <MailField label="Match">
                  <MailSelect
                    value={condition.operator}
                    onValueChange={(nextValue) => updateCondition(index, { operator: nextValue })}
                    options={[
                      ...(["contains", "equals", "prefix", "suffix"].map((operator) => ({
                        value: operator,
                        label:
                          operator === "prefix"
                            ? "Starts with"
                            : operator === "suffix"
                              ? "Ends with"
                              : operator,
                      })) || []),
                    ]}
                  />
                </MailField>
                <MailInput
                  label="Value"
                  value={condition.value}
                  required
                  maxLength={1000}
                  onChange={(event) => updateCondition(index, { value: event.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove condition ${index + 1}`}
                  disabled={conditions.length === 1}
                  onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                >
                  ×
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
            Add condition
          </Button>
          <h3>Then</h3>
          {routing ? (
            <>
              <MailField label="Routing action">
                <MailSelect
                  value={routingAction}
                  onValueChange={(nextValue) => setRoutingAction(nextValue)}
                  options={[
                    { value: "store", label: "Store in mailbox" },
                    { value: "forward", label: "Forward to verified address" },
                    { value: "reject", label: "Reject message" },
                  ]}
                />
              </MailField>
              {routingAction === "forward" && (
                <MailInput
                  label="Verified forwarding address"
                  type="email"
                  value={forwardTo}
                  required
                  onChange={(event) => setForwardTo(event.target.value)}
                />
              )}
              {routingAction === "reject" && (
                <MailInput
                  label="Rejection reason (optional)"
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
                  <MailField label={`Action ${index + 1}`}>
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
                        { value: "move", label: "Move to folder" },
                        { value: "star", label: "Star" },
                        { value: "read", label: "Mark read" },
                        { value: "spam", label: "Mark spam" },
                      ]}
                    />
                  </MailField>
                  {value.type === "move" && (
                    <MailField label="Folder">
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
                    aria-label={`Remove action ${index + 1}`}
                    disabled={actions.length === 1}
                    onClick={() => setActions(actions.filter((_, i) => i !== index))}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                disabled={actions.length >= 10}
                onClick={() => setActions([...actions, { type: "read" }])}
              >
                Add action
              </Button>
            </>
          )}
        </MailFieldset>
        <MailNotice error={action.error} />
        <div className="mail-actions">
          <Button onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={action.busy}>
            {action.busy ? "Saving…" : "Save rule"}
          </Button>
        </div>
      </MailForm>
    </MailModal>
  );
}
