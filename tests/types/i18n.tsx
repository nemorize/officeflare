import type { ReactNode } from "react";
import { en } from "../../shared/i18n/en.ts";
import { defineMessages, defineTranslations } from "../../shared/i18n/resource.ts";
import {
  isMessageKey,
  isStaticMessageKey,
  messageParts,
  messageTemplate,
  plural,
  t,
} from "../../shared/i18n/index.ts";
import { LocalizedMessage } from "../../web/components/i18n.tsx";

// These fixtures are compiled, never executed. An unused @ts-expect-error fails the check.
const source = defineMessages({
  plain: "Save",
  greeting: "Hello {name}, from {team}",
  "guests.one": "{count} guest for {name}",
  "guests.other": "{count} guests for {name}",
  "labels.active": "Active",
});
const translated = defineTranslations(source, {
  plain: "저장",
  greeting: "{team}의 {name}님, {name}님 환영합니다",
  "guests.one": "{name}님의 손님 {count}명",
  "guests.other": "{name}님의 손님 {count}명",
  "labels.active": "활성",
});
defineTranslations(en, { ...en, "workspace.navigation": "{name} 탐색" });
const literal: "Save" = source.plain;
const localizedLiteral: "저장" = translated.plain;
void [literal, localizedLiteral];

const numberMessage = { greeting: 123 };
// @ts-expect-error Resource values must be strings.
defineMessages(numberMessage);
const widenedResource: Record<string, string> = { greeting: "Hello" };
// @ts-expect-error Resource keys and values must retain their literal types.
defineMessages(widenedResource);
const widenedValue = { greeting: "Hello {name}" };
// @ts-expect-error Widened string values cannot be checked for parameter names.
defineMessages(widenedValue);
const unmatchedOpen = { greeting: "Hello {name" } as const;
// @ts-expect-error Placeholder braces must match.
defineMessages(unmatchedOpen);
const unmatchedClose = { greeting: "Hello name}" } as const;
// @ts-expect-error Stray closing braces are invalid.
defineMessages(unmatchedClose);
const emptyPlaceholder = { greeting: "Hello {}" } as const;
// @ts-expect-error Placeholder names must be nonempty identifiers.
defineMessages(emptyPlaceholder);
const nestedPlaceholder = { greeting: "Hello {{name}}" } as const;
// @ts-expect-error Nested placeholders are invalid.
defineMessages(nestedPlaceholder);
const invalidName = { greeting: "Hello {first-name}" } as const;
// @ts-expect-error Placeholder names follow the same identifier grammar as the formatter.
defineMessages(invalidName);
const invalidStart = { greeting: "Hello {1name}" } as const;
// @ts-expect-error Placeholder names cannot start with a digit.
defineMessages(invalidStart);
defineMessages({ greeting: "Hello {_name1} {MAX_DAYS}" });
const missingOther = { "guests.one": "{count} guest" } as const;
// @ts-expect-error Every plural message needs both forms.
defineMessages(missingOther);
const missingOne = { "guests.other": "{count} guests" } as const;
// @ts-expect-error An orphan .other form is also invalid.
defineMessages(missingOne);
const missingCount = { "guests.one": "Guest", "guests.other": "Guests" } as const;
// @ts-expect-error Plural forms must include the count parameter.
defineMessages(missingCount);
const mismatchedForms = {
  "guests.one": "{count} guest",
  "guests.other": "{count} guests for {name}",
} as const;
// @ts-expect-error Both plural forms need the same parameters.
defineMessages(mismatchedForms);
const parameterizedLabel = { "labels.active": "Active {name}" } as const;
// @ts-expect-error enumLabel cannot supply interpolation values.
defineMessages(parameterizedLabel);

const { plain: omitted, ...missingTranslation } = translated;
void omitted;
// @ts-expect-error Every source key must be translated.
defineTranslations(source, missingTranslation);
const additionalTranslation = { ...translated, unexpected: "추가" } as const;
// @ts-expect-error Extra resource keys are rejected even through a variable.
defineTranslations(source, additionalTranslation);
const missingParameter = { ...translated, greeting: "{name}님 환영합니다" } as const;
// @ts-expect-error A translation must preserve all source parameters.
defineTranslations(source, missingParameter);
const wrongParameter = { ...translated, greeting: "{person} {team}" } as const;
// @ts-expect-error Translations cannot rename source parameters.
defineTranslations(source, wrongParameter);
const extraParameter = { ...translated, plain: "저장 {name}" } as const;
// @ts-expect-error Translations cannot introduce parameters.
defineTranslations(source, extraParameter);
const malformedTranslation = { ...translated, plain: "저장 }" } as const;
// @ts-expect-error Translated templates must also have valid syntax.
defineTranslations(source, malformedTranslation);
const nonStringTranslation = { ...translated, plain: false } as const;
// @ts-expect-error Translations must be strings.
defineTranslations(source, nonStringTranslation);
const unionMessage = Math.random() ? "{name} {team}" : "{name}";
const unionTranslation = { ...translated, greeting: unionMessage } as const;
// @ts-expect-error Every possible message variant must retain all parameters.
defineTranslations(source, unionTranslation);
// @ts-expect-error Resource values are readonly.
translated.plain = "수정";
// @ts-expect-error The canonical resource is readonly too.
en["common.save"] = "Changed";

t("common.save");
t("workspace.navigation", { name: "Mail" });
t("workspace.navigation", { name: 42 });
const parameters = { name: "Mail" };
t("workspace.navigation", parameters);
// @ts-expect-error Unknown keys cannot be rendered.
t("common.missing");
// @ts-expect-error Parameterized messages require values.
t("workspace.navigation");
// @ts-expect-error Static messages do not accept interpolation values.
t("common.save", {});
// @ts-expect-error Static messages do not accept explicit undefined either.
t("common.save", undefined);
// @ts-expect-error Parameter names must match the selected key.
t("workspace.navigation", { title: "Mail" });
// @ts-expect-error Unexpected parameters are rejected.
t("workspace.navigation", { name: "Mail", extra: 1 });
const unexpectedParameters = { name: "Mail", extra: 1 };
// @ts-expect-error Exact parameter checking also applies to variables.
t("workspace.navigation", unexpectedParameters);
declare const unionParameters: typeof parameters | typeof unexpectedParameters;
// @ts-expect-error Parameter unions cannot hide additional keys either.
t("workspace.navigation", unionParameters);
// @ts-expect-error Null values must be handled before formatting.
t("workspace.navigation", { name: null });
// @ts-expect-error Undefined values must be handled before formatting.
t("workspace.navigation", { name: undefined });
// @ts-expect-error A boolean is not a display value for string interpolation.
t("workspace.navigation", { name: false });
// @ts-expect-error React elements belong in LocalizedMessage.
t("workspace.navigation", { name: <strong>Mail</strong> });
const mixedKey = Math.random() ? "workspace.navigation" : "authInput.invalid";
// @ts-expect-error Values for only one possible key cannot format a dynamic union safely.
t(mixedKey, { name: "Mail" });
// @ts-expect-error Template reads also require known keys.
messageTemplate("common.missing");

const richValue = <strong>Mail</strong>;
const parts: ReactNode[] = messageParts("workspace.navigation", { name: richValue });
void parts;
// @ts-expect-error Rich parts still require all parameter names.
messageParts("workspace.navigation", {});
// @ts-expect-error Rich parts also reject unexpected parameters from variables.
messageParts("workspace.navigation", unexpectedParameters);
<LocalizedMessage id="workspace.navigation" values={{ name: richValue }} />;
<LocalizedMessage id="workspace.navigation" values={{ name: false }} />;
<LocalizedMessage id="workspace.navigation" values={{ name: null }} />;
<LocalizedMessage id="common.save" values={{}} />;
// @ts-expect-error Rich messages require the values prop.
<LocalizedMessage id="workspace.navigation" />;
// @ts-expect-error The id determines the required parameter names, never the values prop.
<LocalizedMessage id="workspace.navigation" values={{ title: richValue }} />;
// @ts-expect-error Rich messages reject unexpected parameter names.
<LocalizedMessage id="workspace.navigation" values={{ name: richValue, extra: "x" }} />;
// @ts-expect-error Exact rich parameter checks also apply to variables.
<LocalizedMessage id="workspace.navigation" values={unexpectedParameters} />;
// @ts-expect-error Static rich messages require an empty values object.
<LocalizedMessage id="common.save" values={{ name: richValue }} />;

plural("counts.items", 1);
// @ts-expect-error Ordinary messages cannot be used as plural bases.
plural("common.save", 1);
// @ts-expect-error Counts must be numbers.
plural("counts.items", "1");
// @ts-expect-error The count is a separate argument and cannot be supplied again.
plural("counts.items", 1, { count: 1 });

function renderDynamicKey(key: string) {
  if (isStaticMessageKey(key)) t(key);
  if (isMessageKey(key)) {
    messageTemplate(key);
    // @ts-expect-error A general key may still need interpolation values.
    t(key);
  }
}
void renderDynamicKey;
