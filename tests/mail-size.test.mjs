import { test } from "node:test";
import assert from "node:assert/strict";
import { encodedMailBytes, estimatedMessageBytes, maxAttachmentBytes, messageSizeBreakdown, messageSizeLimits } from "../src/mail/size.ts";

test("mail budgets respect different provider ceilings and lower administrator limits", () => {
  const smallProvider = 5 * 1024 ** 2, largeProvider = 40 * 1024 ** 2;
  assert.equal(messageSizeLimits(smallProvider, null).max_send_bytes, smallProvider);
  assert.equal(messageSizeLimits(largeProvider, null).max_send_bytes, largeProvider);
  assert.equal(messageSizeLimits(largeProvider, 10 * 1024 ** 2).max_send_bytes, 10 * 1024 ** 2);
  assert.equal(messageSizeLimits(smallProvider, 10 * 1024 ** 2).max_send_bytes, smallProvider);
  assert.ok(messageSizeLimits(largeProvider, null).max_upload_bytes > messageSizeLimits(smallProvider, null).max_upload_bytes);
});
test("a maximum attachment accounts for base64, line folding and MIME overhead", () => {
  for (const ceiling of [16 * 1024, 64 * 1024, 1024 ** 2, 5 * 1024 ** 2, 40 * 1024 ** 2]) {
    const maximum = maxAttachmentBytes(ceiling);
    const message = (bytes) => ({ text: "", html: "", attachments: [{ size_bytes: bytes, filename: "attachment", content_type: "application/octet-stream" }] });
    if (maximum) assert.ok(estimatedMessageBytes(message(maximum)) <= ceiling);
    assert.ok(estimatedMessageBytes(message(maximum + 1)) > ceiling);
    assert.ok(maximum < ceiling);
  }
  assert.equal(encodedMailBytes(57), 78);
  assert.equal(encodedMailBytes(58), 84);
});
test("all parts of a multilingual message consume the same sending budget", () => {
  const message = { text: "본문", html: "<p>본문</p>", subject: "서울 보고서", to: ["team@example.test"], headers: { References: "<previous@example.test>" }, attachments: [{ size_bytes: 400 * 1024, filename: "서울.pdf", content_type: "application/pdf" }, { size_bytes: 400 * 1024, filename: "image.png", content_type: "image/png", content_id: "inline-image" }] };
  assert.ok(estimatedMessageBytes({ ...message, attachments: message.attachments.slice(0, 1) }) < 1024 ** 2);
  assert.ok(estimatedMessageBytes(message) > 1024 ** 2);
  const plain = estimatedMessageBytes({ text: "aaaa", html: "", attachments: [] });
  assert.ok(estimatedMessageBytes({ text: "서울본문", html: "", attachments: [] }) > plain);
  assert.ok(estimatedMessageBytes({ ...message, text: message.text.repeat(100), html: message.html.repeat(100) }) > estimatedMessageBytes(message));
});
test("composer size categories account for inline images, image attachments and Unicode without double counting", () => {
  const message = {
    subject: "서울 보고서", text: "본문", html: '<p>본문<img src="cid:inline-image"></p>',
    from: "sender@example.test", to: ["team@example.test"], headers: { References: "<previous@example.test>" },
    attachments: [
      { size_bytes: 400 * 1024, filename: "서울.pdf", content_type: "application/pdf", disposition: "attachment" },
      { size_bytes: 200 * 1024, filename: "photo.png", content_type: "image/png", disposition: "attachment" },
      { size_bytes: 100 * 1024, filename: "inline.png", content_type: "image/png", content_id: "inline-image" },
    ],
  };
  const size = messageSizeBreakdown(message);
  assert.equal(size.subject, Buffer.byteLength(message.subject) * 3);
  assert.equal(size.body, encodedMailBytes(Buffer.byteLength(message.text)) + encodedMailBytes(Buffer.byteLength(message.html)));
  assert.equal(size.total, size.subject + size.body + size.images + size.attachments + size.headers);
  assert.equal(size.total, estimatedMessageBytes(message));
  const withoutInlineImage = messageSizeBreakdown({ ...message, attachments: message.attachments.slice(0, 2) });
  assert.equal(withoutInlineImage.images, 0);
  assert.equal(withoutInlineImage.attachments, size.attachments);
  assert.equal(size.total - withoutInlineImage.total, size.images);
  const onlyInlineImage = messageSizeBreakdown({ ...message, attachments: message.attachments.slice(2) });
  assert.equal(onlyInlineImage.attachments, 0);
  assert.equal(onlyInlineImage.images, size.images);
  const withoutSubject = messageSizeBreakdown({ ...message, subject: "" });
  assert.equal(size.total - withoutSubject.total, size.subject);
  assert.equal(withoutSubject.headers, size.headers);
  const empty = messageSizeBreakdown({ text: "", html: "", attachments: [] });
  assert.equal(empty.subject + empty.body + empty.images + empty.attachments, 0);
  assert.ok(empty.headers > 0);
});
