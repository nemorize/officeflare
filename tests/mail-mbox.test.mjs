import { test } from "node:test";
import assert from "node:assert/strict";
import { mboxMessage, unquoteMboxMessage } from "../src/mail/mbox.ts";

test("MBOX encoding preserves non-UTF-8 bytes, line endings and reversible From quoting", () => {
  const raw = Buffer.concat([
    Buffer.from("Subject: Byte preservation\r\n\r\ncaf", "ascii"),
    Buffer.from([0xe9, 0, 0xff, 0x80]),
    Buffer.from(
      "\r\nFrom first\r\n>From second\n>>From third\nFromage\nxFrom middle\n>Other\rFrom same line",
      "ascii",
    ),
  ]);
  const original = Buffer.from(raw);
  const expected = Buffer.concat([
    Buffer.from(
      "From sender@example.test Thu, 01 Jan 1970 00:00:00 GMT\nSubject: Byte preservation\r\n\r\ncaf",
      "ascii",
    ),
    Buffer.from([0xe9, 0, 0xff, 0x80]),
    Buffer.from(
      "\r\n>From first\r\n>>From second\n>>>From third\nFromage\nxFrom middle\n>Other\rFrom same line\n\n",
      "ascii",
    ),
  ]);
  assert.deepEqual(Buffer.from(mboxMessage(raw, "sender@example.test", 0)), expected);
  assert.deepEqual(raw, original);
});

test("MBOX decoding removes exactly one quote from From lines and preserves all other bytes", () => {
  const quoted = Buffer.concat([
    Buffer.from(
      ">From first\r\n>>From second\n>>>From third\n>Fromage\n>Other\nx>From middle\n",
      "ascii",
    ),
    Buffer.from([0, 0xff, 0x80, 0xe9]),
  ]);
  const expected = Buffer.concat([
    Buffer.from(
      "From first\r\n>From second\n>>From third\n>Fromage\n>Other\nx>From middle\n",
      "ascii",
    ),
    Buffer.from([0, 0xff, 0x80, 0xe9]),
  ]);
  assert.deepEqual(Buffer.from(unquoteMboxMessage(quoted)), expected);
  assert.equal(unquoteMboxMessage(expected.subarray(expected.length - 4)).length, 4);
});

test("MBOX framing handles an empty message and prevents separator line injection", () => {
  const result = mboxMessage(new Uint8Array(), "sender@example.test\nFrom forged", 0);
  assert.equal(
    new TextDecoder().decode(result),
    "From sender@example.test From forged Thu, 01 Jan 1970 00:00:00 GMT\n\n\n",
  );
  assert.equal(unquoteMboxMessage(new Uint8Array()).length, 0);
});
