import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
export function timingMetrics(header = "") {
  return Object.fromEntries(
    header.split(",").flatMap((part) => {
      const match = /^\s*([\w]+);(?:dur=([\d.]+)|desc="(\d+)")/.exec(part);
      return match ? [[match[1], Number(match[2] ?? match[3])]] : [];
    }),
  );
}
export async function benchmark({ baseUrl, paths, token, samples = 20, fetcher = fetch }) {
  const base = new URL(baseUrl);
  if (!["https:", "http:"].includes(base.protocol))
    throw new Error("An HTTP(S) base URL is required");
  if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("Remote benchmarks require HTTPS");
  if (!Number.isInteger(samples) || samples < 1 || samples > 100)
    throw new Error("Samples must be between 1 and 100");
  const results = [];
  for (const path of paths) {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/"))
      throw new Error("Benchmark paths must be same-origin API reads");
    const measurements = [];
    for (let i = 0; i < samples + 1; i++) {
      const start = performance.now();
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Benchmark request failed (${response.status})`);
      if (i)
        measurements.push({
          elapsed: performance.now() - start,
          ...timingMetrics(response.headers.get("server-timing") ?? ""),
        });
    }
    const metrics = Object.fromEntries(
      [...new Set(measurements.flatMap(Object.keys))].map((name) => [
        name,
        {
          p50: percentile(
            measurements.map((row) => row[name] ?? 0),
            0.5,
          ),
          p95: percentile(
            measurements.map((row) => row[name] ?? 0),
            0.95,
          ),
        },
      ]),
    );
    results.push({
      path: url.pathname
        .replace(/\/mailboxes\/[^/]+/, "/mailboxes/:mailbox")
        .replace(/\/items\/[^/]+/, "/items/:item"),
      metrics,
    });
  }
  return { samples, results };
}
async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--url", "--paths", "--samples", "--output", "--compare"].includes(args[i]) ||
      !args[i + 1]
    )
      throw new Error(
        "Usage: benchmark.mjs --url URL [--paths JSON_ARRAY] [--samples 20] [--output FILE] [--compare BASELINE_FILE]",
      );
    options[args[i]] = args[i + 1];
  }
  const token = process.env.OFFICEFLARE_BENCHMARK_TOKEN;
  if (!token || !options["--url"])
    throw new Error("Set OFFICEFLARE_BENCHMARK_TOKEN and provide --url");
  const report = await benchmark({
    baseUrl: options["--url"],
    token,
    samples: Number(options["--samples"] ?? 20),
    paths: JSON.parse(
      options["--paths"] ?? '["/api/drive/bootstrap","/api/drive/items","/api/calendar/bootstrap"]',
    ),
  });
  if (options["--compare"]) {
    const baseline = JSON.parse(await readFile(options["--compare"], "utf8"));
    report.comparison = report.results.map((row) => {
      const before = baseline.results.find((value) => value.path === row.path);
      return {
        path: row.path,
        p95_change_percent: before?.metrics.elapsed.p95
          ? 100 * (row.metrics.elapsed.p95 / before.metrics.elapsed.p95 - 1)
          : null,
      };
    });
  }
  const text = JSON.stringify(report, null, 2) + "\n";
  if (options["--output"]) await writeFile(options["--output"], text);
  process.stdout.write(text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
