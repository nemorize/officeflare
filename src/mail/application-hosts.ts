import { applicationHostname } from "../../shared/application-host";

interface HostCache {
  remembered: Set<string>;
  hosts?: string[];
  expires: number;
}
const caches = new WeakMap<object, HostCache>();
function hostCache(env: Env) {
  const binding = env.MAIL_BUCKET ?? env.DB;
  let state = caches.get(binding);
  if (!state) {
    state = { remembered: new Set(), expires: 0 };
    caches.set(binding, state);
  }
  return state;
}
export async function rememberMailApplicationHost(env: Env, url: string) {
  const state = hostCache(env);
  const hostname = applicationHostname(url);
  if (!hostname || state.remembered.has(hostname)) return;
  await env.DB.withSession("first-primary")
    .prepare("INSERT OR IGNORE INTO mail_application_hosts (hostname) VALUES (?)")
    .bind(hostname)
    .run();
  if (state.remembered.size >= 128)
    state.remembered.delete(state.remembered.values().next().value!);
  state.remembered.add(hostname);
  state.hosts = undefined;
  state.expires = 0;
}

export async function mailApplicationHosts(env: Env): Promise<string[]> {
  const state = hostCache(env);
  if (state.hosts && state.expires > Date.now()) return state.hosts;
  const rows = await env.DB.withSession("first-primary")
    .prepare("SELECT hostname FROM mail_application_hosts ORDER BY hostname")
    .all<{ hostname: string }>();
  state.hosts = rows.results.map((row) => row.hostname);
  state.expires = Date.now() + 60_000;
  return state.hosts;
}
