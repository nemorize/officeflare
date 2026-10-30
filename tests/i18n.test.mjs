import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { Script, runInNewContext } from "node:vm";
import { build } from "esbuild";
import { en } from "../shared/i18n/en.ts";
import { t, plural, messageParts, isMessageKey, isStaticMessageKey } from "../shared/i18n/index.ts";
import { enumLabel } from "../shared/i18n/labels.ts";
import { auditUiStrings, findUiStrings } from "../scripts/audit-ui-strings.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function loadModule(entry, exposeSmtp = false) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    external: ["cloudflare:sockets"],
    plugins: exposeSmtp
      ? [
          {
            name: "expose-smtp-for-regression-test",
            setup(builder) {
              builder.onLoad({ filter: /src\/mail\/providers\.ts$/ }, async ({ path }) => ({
                contents: (await readFile(path, "utf8")) + "\nexport { smtpMime };",
                loader: "ts",
              }));
            },
          },
        ]
      : [],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return module.exports;
}

test("named message values are substituted once, without interpreting user content", () => {
  assert.equal(t("workspace.navigation", { name: "Mail" }), "Mail navigation");
  const value = "$& {name} <img src=x>";
  assert.equal(t("workspace.navigation", { name: value }), `${value} navigation`);
  assert.ok(
    Object.entries(en).every(
      ([key, value]) => key.includes(".") && typeof value === "string" && value.length,
    ),
  );
});

test("dynamic keys must be known own properties and static keys cannot need values", () => {
  assert.equal(isMessageKey("workspace.navigation"), true);
  assert.equal(isStaticMessageKey("workspace.navigation"), false);
  assert.equal(isStaticMessageKey("common.save"), true);
  for (const key of ["missing.key", "constructor", "toString", "__proto__"]) {
    assert.equal(isMessageKey(key), false);
    assert.equal(isStaticMessageKey(key), false);
  }
});

test("plural messages include their entire noun or sentence", () => {
  assert.equal(plural("counts.items", 0), "0 items");
  assert.equal(plural("counts.items", 1), "1 item");
  assert.equal(plural("counts.items", 2), "2 items");
  assert.equal(plural("drive.uploading", 1), "Uploading 1 file");
  assert.equal(plural("drive.uploading", 2), "Uploading 2 files");
});

test("rich messages preserve elements, conditional values, and text escaping", async () => {
  const node = createElement("strong", null, "<Mail>");
  assert.equal(messageParts("workspace.navigation", { name: node })[1], node);
  const { LocalizedMessage } = await loadModule("web/components/i18n.tsx");
  assert.equal(
    renderToStaticMarkup(
      createElement(LocalizedMessage, { id: "workspace.navigation", values: { name: node } }),
    ),
    "<strong>&lt;Mail&gt;</strong> navigation",
  );
  for (const name of [false, null, undefined]) {
    assert.equal(
      renderToStaticMarkup(
        createElement(LocalizedMessage, { id: "workspace.navigation", values: { name } }),
      ),
      " navigation",
    );
  }
});

test("enum labels localize presentation while accepting unknown external values", () => {
  assert.equal(enumLabel("needs_action"), "Awaiting response");
  assert.equal(enumLabel("read_only"), "Read only");
  assert.equal(enumLabel("custom_value"), "custom_value");
  assert.equal(enumLabel(null), "");
  const values = new Set(Object.values(en));
  for (const internal of ["NOT ", "Bearer", "HMAC", "private, no-store", "(max-width: 760px)"]) {
    assert.equal(values.has(internal), false, `${internal} must remain a protocol value`);
  }
});

test("mail protocol templates preserve CRLF for every MIME body and attachment", async () => {
  const { smtpMime } = await loadModule("src/mail/providers.ts", true);
  for (const [text, html] of [
    ["Hello", ""],
    ["", "<p>Hello</p>"],
    ["Hello", "<p>Hello</p>"],
  ]) {
    for (const files of [
      [],
      [
        {
          filename: "photo.png",
          content_type: "image/png",
          content: "AA==",
          disposition: "inline",
          content_id: "photo@example.test",
        },
      ],
    ]) {
      const mime = smtpMime(
        {
          from: "sender@example.test",
          to: ["reader@example.test"],
          cc: [],
          subject: "Hello",
          headers: {},
          text,
          html,
        },
        files,
      );
      assert.doesNotMatch(mime, /(?<!\r)\n|\r(?!\n)/);
      assert.match(mime, /MIME-Version: 1\.0\r\n/);
      assert.match(mime, /Content-Transfer-Encoding: base64\r\n\r\n/);
      if (files.length) assert.match(mime, /Content-ID: <photo@example.test>\r\n/);
    }
  }
});

test("public calendar pages emit translated HTML and valid browser scripts", async () => {
  const { invitationPage, sharePage } = await loadModule("src/calendar/public-page.ts");
  const headers = new Headers();
  const context = {
    header: (key, value) => headers.set(key, value),
    html: (value) => new Response(value),
  };
  for (const render of [
    () => invitationPage(context, "invitation"),
    () => invitationPage(context, "registration"),
    () => sharePage(context),
  ]) {
    const html = await render().text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /Loading…/);
    const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Script(scripts[0][1]));
    assert.match(headers.get("Content-Security-Policy"), /script-src 'nonce-/);
  }
  const html = await invitationPage(context, "invitation").text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const helpers = script.slice(0, script.indexOf("const path="));
  assert.equal(runInNewContext(`${helpers};registrationStatus("confirmed")`), "Confirmed");
  assert.equal(
    runInNewContext(`${helpers};message("Organized by {email}",{email:"{email} $&"})`),
    "Organized by {email} $&",
  );
});

test("the UI copy audit catches text, accessibility copy, callbacks, and lowercase labels", () => {
  const source = `export function Screen() { return <>
    <h1>Welcome</h1><input aria-label="Email" placeholder="Type here" />
    <p>{busy ? "saving" : "save"}</p>
    <Button onClick={() => notify.success("Saved")}>Continue</Button>
  </> }`;
  assert.deepEqual(
    findUiStrings(source).map((finding) => finding.value),
    ["Welcome", "Email", "Type here", "saving", "save", "Saved", "Continue"],
  );
  assert.deepEqual(
    findUiStrings(`const options = [{value: "inbox", label: "inbox"}];`).map(
      (finding) => finding.value,
    ),
    ["inbox"],
  );
  assert.deepEqual(
    findUiStrings(`const method = "POST";
    const query = "SELECT * FROM users WHERE id=?";
    const view = <Button className="some class" data-status="pending" aria-label={t("common.save")} />;`),
    [],
  );
});

test("all application source files pass the UI copy audit", async () => {
  const { files, findings } = await auditUiStrings();
  assert.ok(files > 200);
  assert.deepEqual(findings, []);
});
