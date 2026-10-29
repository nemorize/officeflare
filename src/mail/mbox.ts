const from = [70, 114, 111, 109, 32];

function fromLine(raw: Uint8Array, start: number) {
  let position = start;
  while (raw[position] === 62) position++;
  return from.every((byte, index) => raw[position + index] === byte);
}

function nextLine(raw: Uint8Array, start: number) {
  const end = raw.indexOf(10, start);
  return end === -1 ? raw.length : end + 1;
}

// mboxrd quotes every line matching /^>*From / by adding one >. MIME bytes
// and existing quoting remain intact when the archive is read back.
export function mboxMessage(raw: Uint8Array, sender: string, receivedAt: number) {
  let quotes = 0;
  for (let start = 0; start < raw.length; start = nextLine(raw, start))
    if (fromLine(raw, start)) quotes++;
  const envelope = new TextEncoder().encode(
    "From " +
      (sender || "officeflare").replace(/[\r\n]/g, " ") +
      " " +
      new Date(receivedAt * 1000).toUTCString() +
      "\n",
  );
  const result = new Uint8Array(envelope.length + raw.length + quotes + 2);
  result.set(envelope);
  let offset = envelope.length;
  for (let start = 0; start < raw.length;) {
    const end = nextLine(raw, start);
    if (fromLine(raw, start)) result[offset++] = 62;
    result.set(raw.subarray(start, end), offset);
    offset += end - start;
    start = end;
  }
  result[offset++] = 10;
  result[offset] = 10;
  return result;
}

export function unquoteMboxMessage(raw: Uint8Array) {
  let quotes = 0;
  for (let start = 0; start < raw.length; start = nextLine(raw, start))
    if (raw[start] === 62 && fromLine(raw, start)) quotes++;
  if (!quotes) return raw;
  const result = new Uint8Array(raw.length - quotes);
  let offset = 0;
  for (let start = 0; start < raw.length;) {
    const end = nextLine(raw, start),
      content = start + Number(raw[start] === 62 && fromLine(raw, start));
    result.set(raw.subarray(content, end), offset);
    offset += end - content;
    start = end;
  }
  return result;
}
