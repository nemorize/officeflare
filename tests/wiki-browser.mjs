import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

// Verify durable document content instead of depending on an editor status label.
export async function waitForWikiSave(fixture, tab) {
  await tab.locator(".wiki-title").waitFor();
  const pageId = new URL(tab.url()).pathname.split("/").at(-1);
  const expected = await tab.locator(".wiki-page").evaluate((element) => {
    const content = element.querySelector(".collaborative-prose").cloneNode(true);
    content
      .querySelectorAll(".collaboration-carets__caret, [data-file-size]")
      .forEach((node) => node.remove());
    return (element.querySelector(".wiki-title").value + content.textContent).replace(/\s+/g, "");
  });
  let actual;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fixture.mf.dispatchFetch(
      `https://office.test/api/wiki/pages/${pageId}/export`,
      {
        headers: { Authorization: `Bearer ${fixture.tokens.alice}` },
      },
    );
    actual = response.ok ? (await response.text()).replace(/\s+/g, "") : response.status;
    if (actual === expected) return;
    await setTimeout(100);
  }
  assert.equal(actual, expected, "The server must retain the edited document before continuing");
}
