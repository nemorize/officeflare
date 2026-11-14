import { now, uuid } from "../auth/types";
import { fail, errorCode } from "./errors";
import { roomTools } from "./connections";
import { AIService, resolveRequest } from "./service";
import { enqueue } from "./jobs";
import { beginTool } from "./tool-meter";
import { getPayload, putPayload } from "./payloads";
import { reserve, reservationGuard, settings, settle } from "./quota";
import {
  canonical,
  ensureUserSubject,
  first,
  hash,
  identity,
  identityGuard,
  object,
  parse,
  requireUserPermission,
  rows,
  session,
  statement,
} from "./store";
import type {
  AIEnv,
  AIMessage,
  AIPrincipal,
  AIRequest,
  AIRuntime,
  AIToolCall,
  ObjectValue,
} from "./types";

interface Room {
  id: string;
  owner_user_id: string;
  profile_id: string;
  profile_key: string;
  title: string;
  version: number;
  next_message_seq: number;
  instructions_payload_id: string | null;
}
interface Checkpoint {
  messages: AIMessage[];
  next: "inference" | "tools";
  model_steps: number;
  tool_count: number;
  job_generation: number;
  resume_version: number;
  pending_calls?: AIToolCall[];
  assistant_message_id?: string;
}
export interface Run {
  id: string;
  room_id: string;
  actor_user_id: string;
  session_id: string;
  actor_auth_version: number;
  status: string;
  profile_id: string;
  checkpoint_json: string;
  config_snapshot_json: string;
  execution_token: string | null;
  admission_reservation_id: string | null;
  slot_reservation_id: string | null;
  deadline_at: number;
  lease_expires_at: number | null;
  error_code: string | null;
  created_at: number;
}
export async function ownedRoom(env: AIEnv, principal: AIPrincipal, id: string) {
  await requireUserPermission(env, principal, "ai.access");
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const room = await first<Room>(
    env,
    "SELECT r.*,p.key profile_key FROM ai_rooms r JOIN ai_profiles p ON p.id=r.profile_id WHERE r.id=? AND r.owner_user_id=? AND r.deleted_at IS NULL",
    id,
    principal.userId,
  );
  if (!room) fail(404, "AI_NOT_FOUND");
  return room;
}
export async function ownedRun(env: AIEnv, principal: AIPrincipal, id: string) {
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const run = await first<Run>(
    env,
    "SELECT x.* FROM ai_runs x JOIN ai_rooms r ON r.id=x.room_id WHERE x.id=? AND r.owner_user_id=? AND r.deleted_at IS NULL",
    id,
    principal.userId,
  );
  if (!run) fail(404, "AI_NOT_FOUND");
  await ownedRoom(env, principal, run.room_id);
  return run;
}
const principalFor = (run: Run): AIPrincipal => ({
  kind: "user",
  userId: run.actor_user_id,
  sessionId: run.session_id,
  authVersion: run.actor_auth_version,
});
// A cancelled run or a truncated history window can leave tool calls without
// their results. Such fragments are still visible in the room, but cannot be
// submitted as a valid provider conversation in the next run.
function completedHistory(history: AIMessage[]): AIMessage[] {
  const start = history.findIndex((message) => message.role === "user");
  if (start < 0) return [];
  const result: AIMessage[] = [];
  for (let index = start; index < history.length; index++) {
    const message = history[index]!;
    if (message.role === "tool") continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      result.push(message);
      continue;
    }
    const outputs: AIMessage[] = [];
    while (history[index + 1]?.role === "tool") outputs.push(history[++index]!);
    if (
      message.tool_calls.every((call) => outputs.some((output) => output.tool_call_id === call.id))
    ) {
      result.push(
        message,
        ...outputs.filter((output) =>
          message.tool_calls!.some((call) => call.id === output.tool_call_id),
        ),
      );
    } else if (message.content) result.push({ role: "assistant", content: message.content });
  }
  return result;
}
export async function appendMessage(
  env: AIEnv,
  run: Run,
  role: "assistant" | "tool",
  payloadId: string | null,
  status = "completed",
) {
  const id = uuid(),
    won = {
      sql: "EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token=? AND status='running')",
      args: [run.id, run.execution_token!],
    };
  await session(env).batch([
    statement(
      env,
      `INSERT INTO ai_room_messages(id,room_id,seq,role,run_id,payload_id,status) SELECT ?,id,next_message_seq,?,?,?,? FROM ai_rooms WHERE id=? AND ${won.sql}`,
      id,
      role,
      run.id,
      payloadId,
      status,
      run.room_id,
      ...won.args,
    ),
    statement(
      env,
      `UPDATE ai_rooms SET next_message_seq=next_message_seq+1,updated_at=unixepoch() WHERE id=? AND ${won.sql}`,
      run.room_id,
      ...won.args,
    ),
  ]);
  return id;
}
export async function runEvent(env: AIEnv, run: Run, kind: string, payload: unknown) {
  const guard = "EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token IS ?)";
  await session(env).batch([
    statement(
      env,
      `INSERT INTO ai_run_events(run_id,seq,kind,payload_json) SELECT id,next_event_seq,?,? FROM ai_runs WHERE id=? AND ${guard}`,
      kind,
      canonical(payload),
      run.id,
      run.id,
      run.execution_token,
    ),
    statement(
      env,
      `UPDATE ai_runs SET next_event_seq=next_event_seq+1 WHERE id=? AND ${guard}`,
      run.id,
      run.id,
      run.execution_token,
    ),
  ]);
}
export async function createRun(
  env: AIEnv,
  principal: AIPrincipal,
  roomId: string,
  content: string,
  key: string,
) {
  const room = await ownedRoom(env, principal, roomId);
  if (principal.kind !== "user") fail(403, "AI_FORBIDDEN");
  const requestHash = await hash([roomId, content]);
  const existing = await first<Run & { request_hash: string }>(
    env,
    "SELECT * FROM ai_runs WHERE actor_user_id=? AND idempotency_key=?",
    principal.userId,
    key,
  );
  if (existing) {
    if (existing.request_hash !== requestHash) fail(409, "AI_CONFLICT");
    return existing;
  }
  const previous = (
    await rows<{ payload_id: string }>(
      env,
      "SELECT payload_id FROM ai_room_messages WHERE room_id=? AND status='completed' AND payload_id IS NOT NULL ORDER BY seq DESC LIMIT 40",
      roomId,
    )
  ).reverse();
  const messages: AIMessage[] = [];
  if (room.instructions_payload_id)
    messages.push({
      role: "system",
      content: await getPayload<string>(env, room.instructions_payload_id),
    });
  const history = await Promise.all(
    previous.map((message) => getPayload<AIMessage>(env, message.payload_id)),
  );
  messages.push(...completedHistory(history));
  messages.push({ role: "user", content });
  const request: AIRequest = {
    consumer: "hub.chat",
    principal,
    profileKey: room.profile_key,
    idempotencyKey: key,
    sourceRef: { type: "room", id: roomId },
    messages,
  };
  const resolved = await resolveRequest(env, request),
    subject = resolved.billing;
  const limits = parse(resolved.consumer.limits_json);
  const timeout = Math.min(3600, Number(limits.run_timeout_seconds ?? 1800));
  const id = uuid(),
    messageId = uuid(),
    payload = await putPayload(env, subject, principal.userId, "chat.message", {
      role: "user",
      content,
    });
  const checkpoint: Checkpoint = {
    messages,
    next: "inference",
    model_steps: 0,
    tool_count: 0,
    job_generation: 1,
    resume_version: 0,
  };
  const guard = {
    sql: `${resolved.guard.sql} AND EXISTS(SELECT 1 FROM ai_rooms WHERE id=? AND owner_user_id=? AND version=? AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM ai_runs WHERE room_id=? AND status IN('queued','running','waiting_approval','reconciling','cancel_requested'))`,
    args: [...resolved.guard.args, roomId, principal.userId, room.version, roomId],
  };
  const reservation = await reserve(env, {
    operationKey: "run:" + id,
    operationId: id,
    kind: "run",
    context: resolved.context,
    amounts: { chat_runs: 1, concurrent_runs: 1 },
    expiresAt: now() + timeout,
    guard,
    tail: (reservationId, token) => {
      const won = reservationGuard(reservationId, token);
      return [
        statement(
          env,
          `INSERT INTO ai_room_messages(id,room_id,seq,role,author_user_id,client_message_id,payload_id,status) SELECT ?,id,next_message_seq,'user',?,?,?,'completed' FROM ai_rooms WHERE id=? AND ${won.sql}`,
          messageId,
          principal.userId,
          key,
          payload,
          roomId,
          ...won.args,
        ),
        statement(
          env,
          `INSERT INTO ai_runs(id,room_id,actor_user_id,session_id,actor_auth_version,trigger_message_id,profile_id,idempotency_key,request_hash,config_snapshot_json,checkpoint_json,deadline_at,admission_reservation_id,slot_reservation_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${won.sql}`,
          id,
          roomId,
          principal.userId,
          principal.sessionId,
          principal.authVersion,
          messageId,
          room.profile_id,
          key,
          requestHash,
          canonical({
            max_steps: Math.min(50, Number(limits.max_steps ?? 12)),
            max_tool_calls: Math.min(100, Number(limits.max_tool_calls ?? 24)),
            profile_version: resolved.profile.version,
          }),
          canonical(checkpoint),
          now() + timeout,
          reservationId,
          reservationId,
          ...won.args,
        ),
        statement(
          env,
          `UPDATE ai_rooms SET next_message_seq=next_message_seq+1,version=version+1,updated_at=unixepoch() WHERE id=? AND ${won.sql}`,
          roomId,
          ...won.args,
        ),
        statement(
          env,
          `INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) SELECT ?,'run',?,1,?,unixepoch(),unixepoch() WHERE ${won.sql}`,
          uuid(),
          id,
          "run:" + id + ":1",
          ...won.args,
        ),
      ];
    },
  });
  await enqueue(env, "run", id);
  return (await first<Run>(env, "SELECT * FROM ai_runs WHERE id=?", id))!;
}
export async function finishRun(env: AIEnv, run: Run, status: string, code: string | null = null) {
  const finished = await statement(
    env,
    "UPDATE ai_runs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,error_code=?,finished_at=unixepoch(),lease_expires_at=NULL,updated_at=unixepoch() WHERE id=? AND execution_token IS ? AND status IN('queued','running','waiting_approval','reconciling','cancel_requested') RETURNING status",
    status,
    code,
    run.id,
    run.execution_token,
  ).first<{ status: string }>();
  if (!finished) return;
  if (run.admission_reservation_id)
    await settle(env, run.admission_reservation_id, { chat_runs: 1 });
  if (run.slot_reservation_id && run.slot_reservation_id !== run.admission_reservation_id)
    await settle(env, run.slot_reservation_id, {});
  await statement(
    env,
    "UPDATE ai_room_messages SET status='interrupted',version=version+1 WHERE run_id=? AND status='streaming'",
    run.id,
  ).run();
  await runEvent(env, run, "run." + finished.status, { status: finished.status, code });
}
async function checkpoint(env: AIEnv, run: Run, value: Checkpoint) {
  await statement(
    env,
    "UPDATE ai_runs SET checkpoint_json=?,updated_at=unixepoch() WHERE id=? AND execution_token=? AND status='running'",
    canonical(value),
    run.id,
    run.execution_token,
  ).run();
}
async function deferRun(env: AIEnv, run: Run, value: Checkpoint) {
  value.job_generation++;
  await session(env).batch([
    statement(
      env,
      "UPDATE ai_runs SET status='queued',execution_token=NULL,checkpoint_json=?,lease_expires_at=NULL,updated_at=unixepoch() WHERE id=? AND execution_token=? AND status='running'",
      canonical(value),
      run.id,
      run.execution_token,
    ),
    statement(
      env,
      "INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) SELECT ?,'run',?,?,?,unixepoch(),unixepoch() WHERE EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token IS NULL AND status='queued' AND checkpoint_json=?) ON CONFLICT(dedupe_key) DO NOTHING",
      uuid(),
      run.id,
      value.job_generation,
      `run:${run.id}:${value.job_generation}`,
      run.id,
      canonical(value),
    ),
  ]);
  await enqueue(env, "run", run.id, value.job_generation);
}
export async function advanceRun(env: AIEnv, id: string, runtime: AIRuntime = {}) {
  const token = uuid();
  const run = await statement(
    env,
    "UPDATE ai_runs SET status='running',execution_token=?,lease_expires_at=?,updated_at=unixepoch() WHERE id=? AND status='queued' RETURNING *",
    token,
    now() + 600,
    id,
  ).first<Run>();
  if (!run) return;
  const principal = principalFor(run),
    state = parse<Checkpoint>(run.checkpoint_json),
    config = parse<{ max_steps: number; max_tool_calls: number }>(run.config_snapshot_json);
  try {
    const room = await ownedRoom(env, principal, run.room_id);
    await requireUserPermission(env, principal, "ai.runs.create");
    if (now() >= run.deadline_at) fail(422, "AI_LIMIT_REACHED");
    const tools = await roomTools(env, principal, room.id);
    if (state.next === "inference") {
      if (state.model_steps >= config.max_steps) fail(422, "AI_LIMIT_REACHED");
      const subject = await ensureUserSubject(env, run.actor_user_id);
      if (!state.assistant_message_id) {
        state.assistant_message_id = await appendMessage(env, run, "assistant", null, "streaming");
        await checkpoint(env, run, state);
      }
      let partial = "",
        savedAt = 0;
      const result = await new AIService(env, {
        ...runtime,
        onDelta: async (delta) => {
          partial += delta;
          if (partial.length > 1024 * 1024) fail(413, "AI_LIMIT_REACHED");
          if (Date.now() - savedAt < 2000) return;
          savedAt = Date.now();
          await runtime.onDelta?.(delta);
          const payload = await putPayload(env, subject, run.actor_user_id, "chat.partial", {
            role: "assistant",
            content: partial,
          });
          await statement(
            env,
            "UPDATE ai_room_messages SET payload_id=?,version=version+1,updated_at=unixepoch() WHERE id=? AND status='streaming' AND EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token=? AND status='running')",
            payload,
            state.assistant_message_id!,
            run.id,
            token,
          ).run();
        },
      }).execute({
        consumer: "hub.chat",
        principal,
        profileKey: room.profile_key,
        idempotencyKey: `${run.id}:model:${state.model_steps}:resume:${state.resume_version}`,
        sourceRef: { type: "run", id: run.id },
        messages: state.messages,
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
      const assistant: AIMessage = {
        role: "assistant",
        content: result.text,
        ...(result.tool_calls.length ? { tool_calls: result.tool_calls } : {}),
        ...(result.provider_state ? { provider_state: result.provider_state } : {}),
      };
      const payload = await putPayload(env, subject, run.actor_user_id, "chat.message", assistant);
      await statement(
        env,
        "UPDATE ai_room_messages SET payload_id=?,status='completed',version=version+1,updated_at=unixepoch() WHERE id=? AND EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token=?)",
        payload,
        state.assistant_message_id,
        run.id,
        token,
      ).run();
      await statement(
        env,
        "INSERT INTO ai_run_steps(id,run_id,ordinal,kind,invocation_id,status,execution_token,finished_at) VALUES(?,?,?,'inference',?,'succeeded',?,unixepoch()) ON CONFLICT(run_id,ordinal) DO NOTHING",
        uuid(),
        run.id,
        state.model_steps * 2 + 1,
        result.invocation_id,
        token,
      ).run();
      const messageId = state.assistant_message_id;
      state.messages.push(assistant);
      state.assistant_message_id = undefined;
      state.model_steps++;
      await runEvent(env, run, "message.completed", {
        message_id: messageId,
        text: result.text,
        tool_calls: result.tool_calls,
      });
      if (
        (await first<{ status: string }>(env, "SELECT status FROM ai_runs WHERE id=?", run.id))
          ?.status === "cancel_requested"
      ) {
        await finishRun(env, run, "cancelled", "AI_CANCELLED");
        return;
      }
      if (!result.tool_calls.length) {
        await checkpoint(env, run, state);
        await finishRun(env, run, "succeeded");
        return;
      }
      state.next = "tools";
      state.pending_calls = result.tool_calls;
      await deferRun(env, run, state);
      return;
    }
    const stepId = uuid(),
      stepOrdinal = (state.model_steps - 1) * 2 + 2;
    await statement(
      env,
      "INSERT INTO ai_run_steps(id,run_id,ordinal,kind,status,execution_token) VALUES(?,?,?,'tools','running',?) ON CONFLICT(run_id,ordinal) DO NOTHING",
      stepId,
      run.id,
      stepOrdinal,
      token,
    ).run();
    const step = (await first<{ id: string }>(
      env,
      "SELECT id FROM ai_run_steps WHERE run_id=? AND ordinal=?",
      run.id,
      stepOrdinal,
    ))!;
    let pending = false;
    if (state.tool_count + (state.pending_calls?.length ?? 0) > config.max_tool_calls)
      fail(422, "AI_LIMIT_REACHED");
    for (const call of state.pending_calls ?? []) {
      if (
        (await first<{ status: string }>(env, "SELECT status FROM ai_runs WHERE id=?", run.id))
          ?.status !== "running"
      )
        fail(409, "AI_CANCELLED");
      if (state.tool_count >= config.max_tool_calls) fail(422, "AI_LIMIT_REACHED");
      const definition = tools.find((tool) => tool.name === call.name);
      if (!definition) fail(403, "AI_FORBIDDEN");
      const intent = await definition.intent(call.arguments);
      let operation = await first<{
        id: string;
        status: string;
        result_payload_id: string | null;
        intent_snapshot_json: string;
      }>(
        env,
        "SELECT * FROM ai_tool_calls WHERE step_id=? AND provider_call_id=?",
        step.id,
        call.id,
      );
      if (!operation) {
        const callId = uuid(),
          subject = await ensureUserSubject(env, run.actor_user_id),
          payload = await putPayload(
            env,
            subject,
            run.actor_user_id,
            "tool.arguments",
            call.arguments,
          );
        await statement(
          env,
          "INSERT INTO ai_tool_calls(id,run_id,step_id,room_id,actor_user_id,server_id,connection_id,tool_id,provider_call_id,operation_key,args_payload_id,args_hash,intent_snapshot_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(step_id,provider_call_id) DO NOTHING",
          callId,
          run.id,
          step.id,
          run.room_id,
          run.actor_user_id,
          definition.serverId,
          definition.connectionId,
          definition.id,
          call.id,
          "agent-tool:" + callId,
          payload,
          await hash(call.arguments),
          canonical({
            hash: intent,
            connection_version: definition.connectionVersion,
            schema_hash: definition.schemaHash,
          }),
          definition.execution === "read" ? "approved" : "waiting_approval",
        ).run();
        operation = (await first(
          env,
          "SELECT * FROM ai_tool_calls WHERE step_id=? AND provider_call_id=?",
          step.id,
          call.id,
        ))!;
        if (definition.execution !== "read")
          await statement(
            env,
            "INSERT INTO ai_tool_approvals(id,tool_call_id,required_user_id,intent_hash,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(tool_call_id) DO NOTHING",
            uuid(),
            callId,
            run.actor_user_id,
            intent,
            Math.min(run.deadline_at, now() + 900),
          ).run();
      }
      if (parse<{ hash: string }>(operation.intent_snapshot_json).hash !== intent)
        fail(409, "AI_APPROVAL_STALE");
      if (operation.status === "waiting_approval") {
        pending = true;
        continue;
      }
      if (operation.status === "executing" || operation.status === "unknown")
        fail(503, "AI_RESULT_UNKNOWN");
      if (operation.status === "approved") {
        let approvalId: string | null = null;
        if (definition.execution !== "read") {
          const approval = await first<{ id: string }>(
            env,
            "SELECT id FROM ai_tool_approvals WHERE tool_call_id=? AND status='approved' AND expires_at>unixepoch() AND consumed_at IS NULL",
            operation.id,
          );
          if (!approval) fail(409, "AI_APPROVAL_STALE");
          approvalId = approval.id;
        }
        const operationId = operation.id;
        const reservation = await beginTool(
          env,
          principal,
          operationId,
          "hub.chat",
          run.profile_id,
          {
            sql: "EXISTS(SELECT 1 FROM ai_tool_calls WHERE id=? AND status='approved') AND EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND execution_token=? AND status='running') AND (? IS NULL OR EXISTS(SELECT 1 FROM ai_tool_approvals WHERE id=? AND status='approved' AND consumed_at IS NULL AND expires_at>unixepoch()))",
            args: [operationId, run.id, token, approvalId, approvalId],
          },
          (reservationId, mutationToken) => {
            const won = reservationGuard(reservationId, mutationToken);
            return [
              statement(
                env,
                `UPDATE ai_tool_approvals SET consumed_at=unixepoch() WHERE id=? AND ${won.sql}`,
                approvalId,
                ...won.args,
              ),
              statement(
                env,
                `UPDATE ai_tool_calls SET status='executing',execution_token=?,reservation_id=? WHERE id=? AND status='approved' AND ${won.sql}`,
                token,
                reservationId,
                operationId,
                ...won.args,
              ),
            ];
          },
        );
        const claimed = await first<{ operation_key: string }>(
          env,
          "SELECT operation_key FROM ai_tool_calls WHERE id=? AND status='executing' AND execution_token=?",
          operationId,
          token,
        );
        if (claimed) {
          let output: unknown;
          try {
            output = await definition.execute(call.arguments, claimed.operation_key);
          } catch (error) {
            await statement(
              env,
              "UPDATE ai_tool_calls SET status=?,error_code=?,finished_at=unixepoch() WHERE id=? AND execution_token=?",
              definition.execution === "read" ? "failed" : "unknown",
              errorCode(error),
              operation.id,
              token,
            ).run();
            await settle(env, reservation.id, { tool_calls: 1 });
            if (definition.execution !== "read") fail(503, "AI_RESULT_UNKNOWN");
            output = { error: errorCode(error) };
          }
          try {
            const subject = await ensureUserSubject(env, run.actor_user_id),
              payload = await putPayload(env, subject, run.actor_user_id, "tool.result", output);
            await statement(
              env,
              "UPDATE ai_tool_calls SET status=CASE WHEN status='failed' THEN 'failed' ELSE 'succeeded' END,result_payload_id=?,finished_at=unixepoch() WHERE id=? AND execution_token=? AND status IN('executing','failed')",
              payload,
              operation.id,
              token,
            ).run();
          } catch {
            await statement(
              env,
              "UPDATE ai_tool_calls SET status='unknown',error_code='AI_RESULT_UNKNOWN' WHERE id=? AND execution_token=? AND status='executing'",
              operation.id,
              token,
            ).run();
            await settle(env, reservation.id, { tool_calls: 1 });
            fail(503, "AI_RESULT_UNKNOWN");
          }
          await settle(env, reservation.id, { tool_calls: 1 });
        }
      }
    }
    if (pending) {
      if (run.admission_reservation_id)
        await settle(env, run.admission_reservation_id, { chat_runs: 1 });
      if (run.slot_reservation_id && run.slot_reservation_id !== run.admission_reservation_id)
        await settle(env, run.slot_reservation_id, {});
      await statement(
        env,
        "UPDATE ai_runs SET status='waiting_approval',checkpoint_json=?,slot_reservation_id=NULL,lease_expires_at=NULL,updated_at=unixepoch() WHERE id=? AND execution_token=? AND status='running'",
        canonical(state),
        run.id,
        token,
      ).run();
      await runEvent(env, run, "approval.required", { run_id: run.id });
      return;
    }
    for (const call of state.pending_calls ?? []) {
      const operation = (await first<{ status: string; result_payload_id: string | null }>(
        env,
        "SELECT status,result_payload_id FROM ai_tool_calls WHERE step_id=? AND provider_call_id=?",
        step.id,
        call.id,
      ))!;
      const content = operation.result_payload_id
        ? canonical(await getPayload(env, operation.result_payload_id))
        : canonical({ denied: true });
      const message: AIMessage = {
        role: "tool",
        content,
        tool_call_id: call.id,
        tool_name: call.name,
      };
      state.messages.push(message);
      state.tool_count++;
      const subject = await ensureUserSubject(env, run.actor_user_id),
        payload = await putPayload(env, subject, run.actor_user_id, "chat.tool-result", message);
      await appendMessage(env, run, "tool", payload);
    }
    await statement(
      env,
      "UPDATE ai_run_steps SET status='succeeded',finished_at=unixepoch() WHERE id=?",
      step.id,
    ).run();
    state.next = "inference";
    state.pending_calls = [];
    await deferRun(env, run, state);
  } catch (error) {
    if (errorCode(error) === "AI_RESULT_UNKNOWN") {
      await statement(
        env,
        "UPDATE ai_runs SET status='reconciling',error_code='AI_RESULT_UNKNOWN',lease_expires_at=NULL WHERE id=? AND execution_token=?",
        run.id,
        token,
      ).run();
      await runEvent(env, run, "run.reconciling", { code: "AI_RESULT_UNKNOWN" });
    } else
      await finishRun(
        env,
        run,
        errorCode(error) === "AI_CANCELLED" ? "cancelled" : "failed",
        errorCode(error),
      );
  }
}
export async function resumeRun(env: AIEnv, principal: AIPrincipal, id: string) {
  const run = await ownedRun(env, principal, id),
    room = await ownedRoom(env, principal, run.room_id);
  if (
    principal.kind !== "user" ||
    !["waiting_approval", "failed", "reconciling"].includes(run.status)
  )
    fail(409, "AI_CONFLICT");
  await session(env).batch([
    statement(
      env,
      "UPDATE ai_tool_approvals SET status='expired' WHERE tool_call_id IN(SELECT id FROM ai_tool_calls WHERE run_id=?) AND status='pending' AND expires_at<=unixepoch()",
      id,
    ),
    statement(
      env,
      "UPDATE ai_tool_calls SET status='denied' WHERE run_id=? AND status='waiting_approval' AND EXISTS(SELECT 1 FROM ai_tool_approvals a WHERE a.tool_call_id=ai_tool_calls.id AND a.status IN('expired','denied','revoked'))",
      id,
    ),
  ]);
  if (
    run.status === "reconciling" &&
    ((await first(
      env,
      "SELECT id FROM ai_tool_calls WHERE run_id=? AND status IN('unknown','executing') LIMIT 1",
      id,
    )) ||
      (await first(
        env,
        "SELECT id FROM ai_invocations WHERE json_extract(source_ref_json,'$.type')='run' AND json_extract(source_ref_json,'$.id')=? AND status='unknown' LIMIT 1",
        id,
      )))
  )
    fail(409, "AI_RESULT_UNKNOWN");
  if (
    await first(
      env,
      "SELECT t.id FROM ai_tool_calls t JOIN ai_tool_approvals a ON a.tool_call_id=t.id WHERE t.run_id=? AND t.status='waiting_approval' AND a.status='pending' LIMIT 1",
      id,
    )
  )
    fail(409, "AI_BUSY");
  const state = parse<Checkpoint>(run.checkpoint_json);
  state.job_generation++;
  if (run.status === "failed") state.resume_version++;
  const resolved = await resolveRequest(env, {
    consumer: "hub.chat",
    principal,
    profileKey: room.profile_key,
    idempotencyKey: "resume:" + id,
    sourceRef: { type: "run", id },
    messages: state.messages,
  });
  const guard = {
    sql: `${resolved.guard.sql} AND EXISTS(SELECT 1 FROM ai_runs WHERE id=? AND status=? AND checkpoint_json=?) AND NOT EXISTS(SELECT 1 FROM ai_runs WHERE room_id=? AND id<>? AND status IN('queued','running','waiting_approval','reconciling','cancel_requested'))`,
    args: [...resolved.guard.args, id, run.status, run.checkpoint_json, room.id, id],
  };
  await reserve(env, {
    operationKey: `run-slot:${id}:${state.job_generation}`,
    operationId: id,
    kind: "run",
    context: resolved.context,
    amounts: { concurrent_runs: 1 },
    expiresAt: now() + 1800,
    guard,
    tail: (reservationId, token) => {
      const won = reservationGuard(reservationId, token);
      return [
        statement(
          env,
          `UPDATE ai_runs SET status='queued',execution_token=NULL,session_id=?,actor_auth_version=?,slot_reservation_id=?,checkpoint_json=?,deadline_at=?,finished_at=NULL,error_code=NULL,updated_at=unixepoch() WHERE id=? AND status=? AND ${won.sql}`,
          principal.sessionId,
          principal.authVersion,
          reservationId,
          canonical(state),
          now() + 1800,
          id,
          run.status,
          ...won.args,
        ),
        statement(
          env,
          `INSERT INTO ai_jobs(id,kind,entity_id,generation,dedupe_key,available_at,publish_after) SELECT ?,'run',?,?,?,unixepoch(),unixepoch() WHERE ${won.sql} ON CONFLICT(dedupe_key) DO NOTHING`,
          uuid(),
          id,
          state.job_generation,
          `run:${id}:${state.job_generation}`,
          ...won.args,
        ),
      ];
    },
  });
  await enqueue(env, "run", id, state.job_generation);
}
export async function recoverRuns(env: AIEnv) {
  const expired = await rows<Run>(
    env,
    "SELECT * FROM ai_runs WHERE (status IN('running','cancel_requested') AND (lease_expires_at IS NULL OR lease_expires_at<=unixepoch())) OR (status IN('queued','waiting_approval') AND deadline_at<=unixepoch()) ORDER BY created_at LIMIT 25",
  );
  for (const run of expired) {
    const unknown =
      (await first(
        env,
        "SELECT id FROM ai_tool_calls WHERE run_id=? AND status IN('executing','unknown')",
        run.id,
      )) ||
      (await first(
        env,
        "SELECT id FROM ai_invocations WHERE json_extract(source_ref_json,'$.type')='run' AND json_extract(source_ref_json,'$.id')=? AND status IN('running','unknown')",
        run.id,
      ));
    if (unknown) {
      await statement(
        env,
        "UPDATE ai_tool_calls SET status='unknown',error_code='AI_RESULT_UNKNOWN' WHERE run_id=? AND status='executing'",
        run.id,
      ).run();
      await statement(
        env,
        "UPDATE ai_runs SET status='reconciling',error_code='AI_RESULT_UNKNOWN',lease_expires_at=NULL WHERE id=?",
        run.id,
      ).run();
      continue;
    }
    if (run.status === "cancel_requested") {
      await finishRun(env, run, "cancelled", "AI_CANCELLED");
      continue;
    }
    if (run.deadline_at <= now()) {
      await finishRun(env, run, "failed", "AI_LIMIT_REACHED");
      continue;
    }
    await deferRun(env, run, parse<Checkpoint>(run.checkpoint_json));
  }
  // Repair a crash after the final state was committed but before releasing slots.
  const terminal = await rows<{ id: string }>(
    env,
    "SELECT q.id FROM ai_quota_reservations q JOIN ai_runs r ON r.id=q.operation_id WHERE q.operation_kind='run' AND q.status IN('held','uncertain') AND r.status IN('succeeded','failed','cancelled') LIMIT 50",
  );
  for (const reservation of terminal) await settle(env, reservation.id, { chat_runs: 1 });
}
