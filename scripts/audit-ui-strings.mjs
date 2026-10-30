import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const copyAttributes = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "placeholder",
  "title",
  "alt",
  "label",
  "description",
  "hint",
  "help",
  "empty",
  "confirm",
  "message",
  "error",
  "caption",
  "emptyLabel",
  "loadingLabel",
  "confirmLabel",
  "cancelLabel",
  "navigationLabel",
  "data-label",
]);
const internalAttributes = new Set([
  "className",
  "style",
  "id",
  "key",
  "href",
  "src",
  "d",
  "viewBox",
  "name",
  "value",
  "defaultValue",
  "type",
  "role",
  "rel",
  "target",
  "icon",
  "kind",
  "variant",
  "layout",
  "as",
  "font",
  "transform",
]);
const internalProperties = new Set([
  "method",
  "icon",
  "type",
  "id",
  "key",
  "path",
  "href",
  "src",
  "scope",
  "permission",
  "group",
  "service",
  "category",
  "status",
  "value_type",
  "value",
  "defaultValue",
  "response",
  "timeZone",
  "time_zone",
  "locale",
  "format",
  "fontFamily",
  "font",
  "fontSize",
  "textAlign",
  "position",
  "display",
  "width",
  "height",
  "className",
  "event",
  "operation",
  "code",
  "filename",
  "fileName",
  "charset",
  "encoding",
  "contentType",
  "content_type",
  "accept",
  "role",
  "inputMode",
  "token_type",
  "weekday",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "timeZoneName",
  "dateStyle",
  "timeStyle",
  "rel",
]);
const internalCalls = new Set([
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
  "getAttribute",
  "setAttribute",
  "createElement",
  "addEventListener",
  "removeEventListener",
  "getElementById",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "split",
  "replace",
  "replaceAll",
  "match",
  "normalize",
  "get",
  "set",
  "delete",
  "append",
  "has",
  "prepare",
  "exec",
  "batch",
  "run",
  "bind",
  "raw",
  "table",
  "header",
  "setHeader",
  "command",
  "verify",
  "importKey",
  "sign",
]);
const protocolValues = new Set([
  "Bearer",
  "HMAC",
  "STANDARD",
  "DAYLIGHT",
  "Z",
  "A",
  "AAAA",
  "NULL",
  "NOT ",
  " AND ",
  "ASC",
  "DESC",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "UTC",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Backspace",
  "Home",
  "End",
  "From ",
  "INLINE",
  "HTML",
  "Text",
  "STARTTLS",
  "DATA",
  "QUIT",
  "Idempotency-Key",
  "If-Match",
  "set null",
  "noopener noreferrer",
  "en",
]);

function children(node) {
  return Object.entries(node)
    .filter(
      ([key]) =>
        ![
          "loc",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(key),
    )
    .flatMap(([, value]) =>
      Array.isArray(value)
        ? value.filter((child) => child && typeof child.type === "string")
        : value && typeof value.type === "string"
          ? [value]
          : [],
    );
}

function property(node) {
  return node?.key?.name ?? node?.key?.value;
}

/** Find literal copy, including copy in callbacks and option catalogs. */
export function findUiStrings(source, file = "example.tsx") {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const findings = [];
  function visit(node, ancestors = []) {
    if (["StringLiteral", "JSXText", "TemplateLiteral"].includes(node.type)) {
      const parent = ancestors.at(-1);
      const value =
        node.type === "TemplateLiteral"
          ? node.quasis.map((part) => part.value.cooked ?? part.value.raw).join("")
          : node.value;
      const attrIndex = ancestors.findLastIndex((item) => item.type === "JSXAttribute");
      const attribute = ancestors[attrIndex];
      const directCopy =
        node.type === "JSXText" ||
        (parent?.type === "JSXAttribute" && copyAttributes.has(parent.name.name));
      const messageValue =
        (parent?.type === "ObjectProperty" &&
          parent.value === node &&
          ["label", "title", "description", "message", "help", "hint", "impact"].includes(
            property(parent),
          )) ||
        (parent?.type === "NewExpression" && /Error$/.test(parent.callee.name ?? "")) ||
        (parent?.type === "CallExpression" &&
          ["setError", "success", "error", "info", "alert", "confirm", "prompt"].includes(
            parent.callee.property?.name ?? parent.callee.name,
          ));
      const containerIndex = ancestors.findLastIndex(
        (item) => item.type === "JSXExpressionContainer",
      );
      const containerParent = ancestors[containerIndex - 1];
      const rendered =
        containerIndex >= 0 &&
        (containerParent?.type !== "JSXAttribute" ||
          copyAttributes.has(containerParent.name.name) ||
          containerParent.name.name === "values");
      const isKey =
        (parent?.type === "ObjectProperty" && parent.key === node) ||
        (["MemberExpression", "OptionalMemberExpression"].includes(parent?.type) &&
          parent.property === node) ||
        (parent?.type === "SwitchCase" && parent.test === node);
      const internal =
        !directCopy &&
        (ancestors.some((item) =>
          /^(?:TSLiteralType|TSPropertySignature|ImportDeclaration|ExportAllDeclaration)$/.test(
            item.type,
          ),
        ) ||
          isKey ||
          (parent?.type === "BinaryExpression" &&
            ["===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(parent.operator)) ||
          parent?.type === "TaggedTemplateExpression" ||
          parent?.type === "JSXAttribute" ||
          (attribute &&
            internalAttributes.has(attribute.name.name) &&
            !ancestors
              .slice(attrIndex + 1)
              .some((item) =>
                ["ArrowFunctionExpression", "FunctionExpression"].includes(item.type),
              )) ||
          ancestors.some(
            (item) =>
              item.type === "ObjectProperty" &&
              ["style", "headers", "httpMetadata"].includes(property(item)),
          ) ||
          (parent?.type === "ObjectProperty" && internalProperties.has(property(parent))) ||
          (parent?.type === "ObjectProperty" && property(parent) === value) ||
          (parent?.type === "NewExpression" &&
            /^[A-Z0-9_]+$/.test(value) &&
            parent.callee.name !== "Error") ||
          (parent?.type === "CallExpression" &&
            (parent.callee.name === "t" ||
              parent.callee.name === "plural" ||
              internalCalls.has(parent.callee.property?.name ?? parent.callee.name))) ||
          ancestors.some(
            (item) => item.type === "CallExpression" && item.callee.object?.name === "console",
          ) ||
          ancestors.some(
            (item) =>
              item.type === "CallExpression" &&
              ["can", "allowed", "includes", "enumLabel", "downloadMail"].includes(
                item.callee.property?.name ?? item.callee.name,
              ),
          ) ||
          (ancestors.some(
            (item) => item.type === "CallExpression" && ["t", "plural"].includes(item.callee.name),
          ) &&
            /^[a-zA-Z]+\.[\w.]+$/.test(value)) ||
          (parent?.type === "ArrayExpression" && /^(?:[a-z][\w.-]*|[A-Z]{2})$/.test(value)) ||
          protocolValues.has(value) ||
          /^(?:[a-z]+:\/\/|data:|blob:|urn:|mailto:|\/|#|\.[\w/]|--|\*\/|\{)/i.test(value) ||
          /<\/?[a-z!]/i.test(value) ||
          /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|JOIN|LIMIT|OFFSET|ASC|DESC|AND|ORDER BY|GROUP BY|VALUES|LIKE|COLLATE|COALESCE|CASE WHEN|NOT IN)\b|\bIS (?:NOT )?NULL\b/.test(
            value,
          ) ||
          /^\s*(?:default-src|script-src|attachment;|inline;|Bearer |Basic |bytes[ =]|boundary=|text\/|application\/|image\/|font\/|video\/|audio\/|message\/|@media|EHLO |AUTH PLAIN|MAIL FROM:|RCPT TO:|Zoho-enczapikey)/.test(
            value,
          ) ||
          /^(?:From:|Reply-To:|To:|Cc:|Bcc:|Subject:|Message-ID:|Date:|MIME-Version:|X-Officeflare-Export:|Content-[\w-]+:|; filename=|host:|x-amz-)/.test(
            value.trimStart(),
          ) ||
          /^AWS4-HMAC-SHA256/.test(value) ||
          /^(?:private, no-store|public, max-age=|noindex, nofollow|\\3c |UI\(|\(prefers-color-scheme:|\(max-width:|only )/.test(
            value,
          ) ||
          /^M[\d .-]+/i.test(value) ||
          /^\s*(?:NOT|IN|POST)\b/.test(value) ||
          /^\s*function\s+\w+\s*\(/.test(value) ||
          value.includes(">(()=>{") ||
          /(?:officeflare:|px;|!important)/.test(value) ||
          /^MAIL:/.test(value));
      if (
        !internal &&
        /[a-zA-Z가-힣日本語]/.test(value) &&
        (directCopy ||
          messageValue ||
          rendered ||
          /\s/.test(value) ||
          /^[A-Z(][A-Za-z0-9 ()&'’.,!?:+—–-]*[a-z…)]$/.test(value))
      )
        findings.push({ file, line: node.loc.start.line, value });
    }
    for (const child of children(node)) visit(child, [...ancestors, node]);
  }
  visit(ast.program);
  return findings;
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(root, entry.name))
        : [path.join(root, entry.name)],
    ),
  );
  return files.flat().filter((file) => /\.tsx?$/.test(file));
}

export async function auditUiStrings() {
  const files = (await Promise.all([sourceFiles("web"), sourceFiles("src")])).flat();
  const findings = (
    await Promise.all(files.map(async (file) => findUiStrings(await readFile(file, "utf8"), file)))
  ).flat();
  return { files: files.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { files, findings } = await auditUiStrings();
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: ${JSON.stringify(finding.value)}`);
  console.log(`Audited ${files} source files; ${findings.length} hardcoded UI strings.`);
  if (findings.length) process.exitCode = 1;
}
