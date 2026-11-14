import { t } from "../../shared/i18n/index.ts";
import {
  useAIResource,
  aiMoney,
  aiMetric,
  aiWindow,
  type AIQuotaBucket,
  type AIQuotaRule,
} from "../lib/ai";
import {
  ConsoleMetrics,
  ConsoleSection,
  ConsoleSettingsHeader,
  ConsoleState,
} from "../components/console-settings";
import { Button, Icon } from "../components/ui";
export function AIUsagePage() {
  const usage = useAIResource<{
    usage: {
      invocations: number;
      input_tokens: number;
      output_tokens: number;
      cost_micro_usd: number | null;
      unknown_cost_events: number;
    };
  }>("/api/ai/usage");
  const quota = useAIResource<{
    user_subject_id: string;
    time_zone: string;
    rules: (AIQuotaRule & { subject_id: string })[];
    buckets: AIQuotaBucket[];
  }>("/api/ai/quota");
  const rules =
    quota.data?.rules.filter((rule) => rule.subject_id === quota.data?.user_subject_id) ?? [];
  return (
    <section className="account-page console-page ai-settings-page">
      <ConsoleSettingsHeader title={t("aiui.usage")} description={t("aiui.usageHint")}>
        <Button
          variant="ghost"
          onClick={() => {
            usage.reload();
            quota.reload();
          }}
        >
          <Icon name="refresh" />
          {t("aiui.refresh")}
        </Button>
      </ConsoleSettingsHeader>
      <ConsoleState loading={usage.loading || quota.loading} error={usage.error || quota.error} />
      {usage.data && (
        <ConsoleMetrics
          items={[
            { label: t("aiui.requests"), value: usage.data.usage.invocations.toLocaleString() },
            { label: t("aiui.inputTokens"), value: usage.data.usage.input_tokens.toLocaleString() },
            {
              label: t("aiui.outputTokens"),
              value: usage.data.usage.output_tokens.toLocaleString(),
            },
            { label: t("aiui.cost"), value: aiMoney(usage.data.usage.cost_micro_usd) },
          ]}
        />
      )}
      {!!usage.data?.usage.unknown_cost_events && (
        <p className="account-notice">{t("aiui.unpricedHint")}</p>
      )}
      <ConsoleSection title={t("aiui.yourLimits")} description={t("aiui.limitsHint")}>
        <div className="ai-quota-list">
          {rules.map((rule) => {
            const bucket = quota.data?.buckets.find(
              (item) =>
                item.metric === rule.metric &&
                item.window_kind === rule.window_kind &&
                item.scope_key === rule.scope_key,
            );
            const used = bucket?.used_amount ?? 0,
              reserved = bucket?.reserved_amount ?? 0,
              amount = (value: number) =>
                rule.metric === "cost_micro_usd" ? aiMoney(value) : value.toLocaleString();
            return (
              <div
                className="ai-quota-row"
                key={[rule.metric, rule.window_kind, rule.scope_key].join(":")}
              >
                <div>
                  <strong>{aiMetric(rule.metric)}</strong>
                  <span>
                    {aiWindow(rule.window_kind)}
                    {rule.scope_key !== "*" && ` · ${rule.scope_key}`}
                  </span>
                </div>
                <p>
                  {amount(used + reserved)}{" "}
                  <span>
                    / {rule.limit_value === null ? t("aiui.unlimited") : amount(rule.limit_value)}
                  </span>
                </p>
                {rule.limit_value !== null && (
                  <progress
                    aria-label={aiMetric(rule.metric)}
                    value={Math.min(rule.limit_value, used + reserved)}
                    max={rule.limit_value || 1}
                  />
                )}{" "}
                {!!reserved && <small>{t("aiui.reserved", { amount: amount(reserved) })}</small>}
              </div>
            );
          })}
        </div>
        {!rules.length && !quota.loading && (
          <p className="ai-empty-inline">{t("aiui.noPersonalLimits")}</p>
        )}
      </ConsoleSection>
    </section>
  );
}
