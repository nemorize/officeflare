import * as Y from "yjs";
import { decodeBytes, MAX_STATE_BYTES } from "../../shared/collaboration";
import { richTextValue } from "../../shared/rich-text";
import { Hono } from "hono";
import { t } from "../../shared/i18n/index.ts";
import type { WikiComment, WikiPage, WikiSpace } from "../../shared/wiki";
import { requireAccess } from "../auth/store";
import { body } from "../auth/input";
import { uuid, type AppEnv } from "../auth/types";
import { requirePermission, requestPermissions } from "../authorization/access";
import {
  actorCte,
  actorOf,
  check,
  cleanPath,
  fail,
  getPage,
  getSpace,
  id,
  mutate,
  pageCondition,
  pageFilter,
  pageRank,
  pageVersion,
  permissionCondition,
  role,
  row,
  rows,
  spaceCondition,
  spaceRank,
  spaceVersion,
  stmt,
  subtree,
  text,
  version,
} from "../wiki/store";

const wiki = new Hono<AppEnv>();
wiki.use("*", requireAccess, requirePermission("wiki.access"));
wiki.get("/capabilities", async (c) =>
  c.json({ permissions: (await requestPermissions(c)).filter((v) => v.startsWith("wiki.")) }),
);
wiki.get("/spaces", async (c) =>
  c.json({
    spaces: await rows<WikiSpace>(
      c.env,
      `${actorCte} SELECT s.*,${spaceRank()} AS role FROM wiki_spaces s CROSS JOIN actor WHERE s.archived_at IS NULL AND ${spaceRank()}>=1 ORDER BY s.created_at,s.id`,
      actorOf(c).user_id,
    ),
  }),
);
wiki.post("/spaces", requirePermission("wiki.spaces.create"), async (c) => {
  const data = await body(c, ["name", "description", "kind"]),
    space = uuid(),
    name = text(data.name),
    kind = data.kind ?? "team";
  if (kind !== "team" && kind !== "personal") fail(400);
  if (
    kind === "personal" &&
    (await row(
      c.env,
      "SELECT 1 FROM wiki_spaces WHERE owner_user_id=? AND kind='personal'",
      actorOf(c).user_id,
    ))
  )
    fail(409, "wiki.changed");
  const description = data.description === undefined ? "" : text(data.description, 1000);
  await mutate(
    c,
    "wiki.spaces.create",
    [],
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO wiki_spaces(id,name,description,kind,owner_user_id) SELECT ?,?,?,?,? WHERE ${proof}`,
        space,
        name,
        description,
        kind,
        actorOf(c).user_id,
      ),
    ],
    { space, action: "space.created" },
  );
  return c.json({ space: await getSpace(c, space) }, 201);
});
wiki.get("/spaces/:id", async (c) => c.json({ space: await getSpace(c, c.req.param("id")) }));
wiki.patch("/spaces/:id", requirePermission("wiki.sharing.internal"), async (c) => {
  const space = await getSpace(c, c.req.param("id"), 4),
    data = await body(c, ["name", "description", "version"]);
  if (version(data.version) !== space.version) fail(412, "wiki.changed");
  const name = data.name === undefined ? space.name : text(data.name),
    description =
      data.description === undefined
        ? space.description
        : data.description === ""
          ? ""
          : text(data.description, 1000);
  await mutate(
    c,
    "wiki.sharing.internal",
    [spaceCondition(actorOf(c).user_id, space.id, 4), spaceVersion(space)],
    (proof) => [
      stmt(
        c.env,
        `UPDATE wiki_spaces SET name=?,description=?,version=version+1 WHERE id=? AND ${proof}`,
        name,
        description,
        space.id,
      ),
    ],
    { space: space.id, action: "space.updated" },
  );
  return c.json({ space: await getSpace(c, space.id) });
});
wiki.get("/spaces/:id/people", async (c) => {
  const space = await getSpace(c, c.req.param("id"));
  return c.json({
    members: await rows(
      c.env,
      "SELECT u.id AS user_id,u.email_address,u.display_name,CASE WHEN u.id=? THEN 'owner' ELSE m.role END AS role FROM users u LEFT JOIN wiki_space_members m ON m.user_id=u.id AND m.space_id=? WHERE (u.id=? OR m.user_id IS NOT NULL) AND u.deleted_at IS NULL AND u.disabled_at IS NULL ORDER BY u.email_address",
      space.owner_user_id,
      space.id,
      space.owner_user_id,
    ),
  });
});
wiki.get("/spaces/:id/members", async (c) => {
  const space = await getSpace(c, c.req.param("id"), 4);
  const members = await rows(
    c.env,
    `SELECT u.id AS user_id,u.email_address,u.display_name,CASE WHEN u.id=? THEN 'owner' ELSE m.role END AS role
    FROM users u LEFT JOIN wiki_space_members m ON m.user_id=u.id AND m.space_id=?
    WHERE (u.id=? OR m.user_id IS NOT NULL) AND u.deleted_at IS NULL ORDER BY u.email_address`,
    space.owner_user_id,
    space.id,
    space.owner_user_id,
  );
  return c.json({ members, version: space.acl_version });
});
wiki.put("/spaces/:id/members", requirePermission("wiki.sharing.internal"), async (c) => {
  const space = await getSpace(c, c.req.param("id"), 4),
    data = await body(c, ["email", "role", "version"]),
    grant = role(data.role);
  if (space.kind === "personal") fail(403, "wiki.denied");
  if (version(data.version) !== space.acl_version) fail(412, "wiki.changed");
  const email = text(data.email, 254),
    user = await row<{ id: string }>(
      c.env,
      "SELECT id FROM users WHERE email_address=? COLLATE NOCASE AND deleted_at IS NULL AND disabled_at IS NULL",
      email,
    );
  if (!user || user.id === space.owner_user_id) fail(400);
  const eligible = permissionCondition(user.id, "wiki.access");
  await mutate(
    c,
    "wiki.sharing.internal",
    [spaceCondition(actorOf(c).user_id, space.id, 4), spaceVersion(space), eligible],
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO wiki_space_members(space_id,user_id,role) SELECT ?,?,? WHERE ${proof} ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role`,
        space.id,
        user.id,
        grant,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET acl_version=acl_version+1 WHERE id=? AND ${proof}`,
        space.id,
      ),
    ],
    { space: space.id, action: "member.granted" },
  );
  return c.json({ version: space.acl_version + 1 });
});
wiki.delete(
  "/spaces/:id/members/:userId",
  requirePermission("wiki.sharing.internal"),
  async (c) => {
    const space = await getSpace(c, c.req.param("id"), 4),
      user = id(c.req.param("userId"));
    if (user === space.owner_user_id) fail(403, "wiki.denied");
    if (version(Number(c.req.query("version"))) !== space.acl_version) fail(412, "wiki.changed");
    await mutate(
      c,
      "wiki.sharing.internal",
      [spaceCondition(actorOf(c).user_id, space.id, 4), spaceVersion(space)],
      (proof) => [
        stmt(
          c.env,
          `DELETE FROM wiki_space_members WHERE space_id=? AND user_id=? AND ${proof}`,
          space.id,
          user,
        ),
        stmt(
          c.env,
          `DELETE FROM wiki_page_grants WHERE user_id=? AND page_id IN(SELECT id FROM wiki_pages WHERE space_id=?) AND ${proof}`,
          user,
          space.id,
        ),
        stmt(
          c.env,
          `UPDATE wiki_spaces SET acl_version=acl_version+1 WHERE id=? AND ${proof}`,
          space.id,
        ),
      ],
      { space: space.id, action: "member.removed" },
    );
    return c.body(null, 204);
  },
);
wiki.post("/spaces/:id/owner", requirePermission("wiki.sharing.internal"), async (c) => {
  const space = await getSpace(c, c.req.param("id"), 5),
    data = await body(c, ["user_id", "version"]),
    target = id(data.user_id);
  if (
    space.kind === "personal" ||
    version(data.version) !== space.version ||
    target === space.owner_user_id
  )
    fail(400);
  await mutate(
    c,
    "wiki.sharing.internal",
    [
      spaceCondition(actorOf(c).user_id, space.id, 5),
      spaceVersion(space),
      check(
        "EXISTS(SELECT 1 FROM wiki_space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? AND m.user_id=? AND u.deleted_at IS NULL AND u.disabled_at IS NULL)",
        space.id,
        target,
      ),
    ],
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO wiki_space_members(space_id,user_id,role) SELECT ?,?,'manager' WHERE ${proof} ON CONFLICT(space_id,user_id) DO UPDATE SET role='manager'`,
        space.id,
        space.owner_user_id,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET owner_user_id=?,version=version+1,acl_version=acl_version+1 WHERE id=? AND ${proof}`,
        target,
        space.id,
      ),
    ],
    { space: space.id, action: "owner.transferred" },
  );
  return c.json({ space: await getSpace(c, space.id) });
});
wiki.get("/spaces/:id/pages", async (c) => {
  const space = await getSpace(c, c.req.param("id")),
    user = actorOf(c).user_id,
    trash = c.req.query("trash") === "true",
    cursor = c.req.query("cursor"),
    query = c.req.query("q")?.trim() ?? "";
  if (cursor) id(cursor);
  if (query.length > 100) fail(400);
  const parent = c.req.query("parent_id"),
    favorites = c.req.query("favorites") === "true";
  const filters = [pageFilter(trash ? 3 : 1, trash), "p.space_id=?"],
    args: (string | number | null)[] = [user, space.id];
  if (trash) filters.push("p.trashed_at IS NOT NULL");
  if (cursor) {
    filters.push("p.id>?");
    args.push(cursor);
  }
  if (parent !== undefined) {
    filters.push("p.parent_id IS ?");
    args.push(parent === "root" ? null : id(parent));
  }
  if (query) {
    filters.push("(instr(lower(p.title),lower(?))>0 OR instr(lower(p.plain_text),lower(?))>0)");
    args.push(query, query);
  }
  if (favorites)
    filters.push(
      "EXISTS(SELECT 1 FROM wiki_favorites f WHERE f.page_id=p.id AND f.user_id=actor.user_id)",
    );
  const list = await rows<WikiPage>(
    c.env,
    `${actorCte} SELECT p.id,p.space_id,p.parent_id,p.resource_id,p.title,p.icon,p.sort_order,p.permission_mode,p.version,p.projected_epoch,p.projected_seq,p.created_by,p.created_at,p.updated_at,p.trashed_at,p.purged_at,${pageRank()} AS role,EXISTS(SELECT 1 FROM wiki_favorites f WHERE f.page_id=p.id AND f.user_id=actor.user_id) AS favorite FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id CROSS JOIN actor WHERE ${filters.join(" AND ")} ORDER BY p.id LIMIT 101`,
    ...args,
  );
  return c.json({
    pages: list.slice(0, 100),
    next_cursor: list.length > 100 ? list[99]!.id : null,
  });
});
wiki.post("/spaces/:id/pages", requirePermission("wiki.pages.create"), async (c) => {
  const space = await getSpace(c, c.req.param("id")),
    data = await body(c, ["parent_id"]),
    parent =
      data.parent_id === null || data.parent_id === undefined
        ? null
        : await getPage(c, id(data.parent_id), 3);
  if (parent && parent.space_id !== space.id) fail(400);
  if (!parent && space.role < 3) fail(403, "wiki.denied");
  const page = uuid(),
    resource = uuid(),
    user = actorOf(c).user_id;
  const checks = [
    spaceVersion(space),
    parent ? pageCondition(user, parent.id, 3) : spaceCondition(user, space.id, 3),
  ];
  if (parent)
    checks.push(
      check(
        `(WITH RECURSIVE path(id,parent_id,depth) AS(SELECT id,parent_id,1 FROM wiki_pages WHERE id=? UNION ALL SELECT p.id,p.parent_id,path.depth+1 FROM wiki_pages p JOIN path ON p.id=path.parent_id WHERE path.depth<33) SELECT MAX(depth) FROM path)<32`,
        parent.id,
      ),
    );
  await mutate(
    c,
    "wiki.pages.create",
    checks,
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO collaboration_resources(id,service,resource_id,schema_key) SELECT ?,'wiki',?,'rich-text.v1' WHERE ${proof}`,
        resource,
        page,
      ),
      stmt(
        c.env,
        `INSERT INTO wiki_pages(id,space_id,parent_id,resource_id,created_by,sort_order) SELECT ?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM wiki_pages WHERE space_id=? AND parent_id IS ?),0) WHERE ${proof}`,
        page,
        space.id,
        parent?.id ?? null,
        resource,
        user,
        space.id,
        parent?.id ?? null,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET tree_version=tree_version+1 WHERE id=? AND ${proof}`,
        space.id,
      ),
    ],
    { space: space.id, page, action: "page.created" },
  );
  return c.json({ page: await getPage(c, page) }, 201);
});
wiki.get("/pages/:id", async (c) => c.json({ page: await getPage(c, c.req.param("id")) }));
wiki.get("/pages/:id/export", requirePermission("wiki.pages.export"), async (c) => {
  const page = await getPage(c, c.req.param("id"));
  const result = await c.env.COLLABORATION_ROOM.get(
    c.env.COLLABORATION_ROOM.idFromName(page.resource_id),
  ).inspect(page.resource_id, actorOf(c), "content");
  if (result.status !== 200 || !("state" in result)) fail(404, "wiki.notFound");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decodeBytes(result.state, MAX_STATE_BYTES));
    const value = richTextValue(doc);
    return new Response(`${value.title}\n\n${value.text}`, {
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(value.title || "page")}.txt`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    doc.destroy();
  }
});
wiki.patch("/pages/:id", requirePermission("wiki.pages.update"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 3),
    data = await body(c, ["icon", "version"]);
  if (version(data.version) !== page.version) fail(412, "wiki.changed");
  const icon = data.icon === "" ? "" : text(data.icon, 16);
  await mutate(
    c,
    "wiki.pages.update",
    [pageCondition(actorOf(c).user_id, page.id, 3), pageVersion(page)],
    (proof) => [
      stmt(
        c.env,
        `UPDATE wiki_pages SET icon=?,version=version+1 WHERE id=? AND ${proof}`,
        icon,
        page.id,
      ),
    ],
    { space: page.space_id, page: page.id, action: "page.updated" },
  );
  return c.json({ page: await getPage(c, page.id) });
});
wiki.post("/pages/:id/moves", requirePermission("wiki.pages.move"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 4),
    space = await getSpace(c, page.space_id),
    data = await body(c, ["parent_id", "version", "sort_order"]),
    parent = data.parent_id === null ? null : await getPage(c, id(data.parent_id), 4);
  if (version(data.version) !== page.version) fail(412, "wiki.changed");
  if (parent && parent.space_id !== page.space_id) fail(400);
  const order = Number(data.sort_order ?? 0);
  if (!Number.isSafeInteger(order) || order < 0 || order > 1000000) fail(400);
  const checks = [
    pageCondition(actorOf(c).user_id, page.id, 4),
    pageVersion(page),
    spaceVersion(space),
    parent
      ? pageCondition(actorOf(c).user_id, parent.id, 4)
      : spaceCondition(actorOf(c).user_id, space.id, 4),
    check(`? NOT IN(${subtree})`, parent?.id ?? "", page.id),
  ];
  checks.push(
    check(
      `(WITH RECURSIVE descendants(id,depth) AS(SELECT id,1 FROM wiki_pages WHERE id=? UNION ALL SELECT p.id,d.depth+1 FROM wiki_pages p JOIN descendants d ON p.parent_id=d.id),ancestors(id,parent_id,depth) AS(SELECT id,parent_id,1 FROM wiki_pages WHERE id=? UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM wiki_pages p JOIN ancestors a ON p.id=a.parent_id) SELECT COALESCE((SELECT MAX(depth) FROM descendants),0)+COALESCE((SELECT MAX(depth) FROM ancestors),0))<=32`,
      page.id,
      parent?.id ?? "",
    ),
  );
  await mutate(
    c,
    "wiki.pages.move",
    checks,
    (proof) => [
      stmt(
        c.env,
        `UPDATE wiki_pages SET parent_id=?,sort_order=?,version=version+1 WHERE id=? AND ${proof}`,
        parent?.id ?? null,
        order,
        page.id,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET tree_version=tree_version+1,acl_version=acl_version+1 WHERE id=? AND ${proof}`,
        space.id,
      ),
    ],
    { space: space.id, page: page.id, action: "page.moved" },
  );
  return c.json({ page: await getPage(c, page.id) });
});
wiki.get("/pages/:id/grants", async (c) => {
  const page = await getPage(c, c.req.param("id"), 4),
    space = await getSpace(c, page.space_id);
  return c.json({
    permission_mode: page.permission_mode,
    version: page.version,
    acl_version: space.acl_version,
    grants: await rows(
      c.env,
      "SELECT g.user_id,g.role,u.display_name,u.email_address FROM wiki_page_grants g JOIN users u ON u.id=g.user_id WHERE g.page_id=? ORDER BY u.email_address",
      page.id,
    ),
  });
});
wiki.put("/pages/:id/grants", requirePermission("wiki.sharing.internal"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 4),
    space = await getSpace(c, page.space_id),
    data = await body(c, ["permission_mode", "grants", "version", "acl_version"]);
  if (version(data.version) !== page.version || version(data.acl_version) !== space.acl_version)
    fail(412, "wiki.changed");
  if (data.permission_mode !== "inherit" && data.permission_mode !== "restricted") fail(400);
  if (!Array.isArray(data.grants) || data.grants.length > 100) fail(400);
  const grants = data.grants.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") fail(400);
    const g = entry as Record<string, unknown>;
    return { user_id: id(g.user_id), role: role(g.role) };
  });
  if (new Set(grants.map((g) => g.user_id)).size !== grants.length) fail(400);
  await mutate(
    c,
    "wiki.sharing.internal",
    [
      pageCondition(actorOf(c).user_id, page.id, 4),
      pageVersion(page),
      spaceVersion(space),
      check(
        `NOT EXISTS(SELECT 1 FROM json_each(?) g WHERE NOT EXISTS(SELECT 1 FROM wiki_space_members m WHERE m.space_id=? AND m.user_id=json_extract(g.value,'$.user_id')) AND json_extract(g.value,'$.user_id')<>?)`,
        JSON.stringify(grants),
        space.id,
        space.owner_user_id,
      ),
    ],
    (proof) => [
      stmt(c.env, `DELETE FROM wiki_page_grants WHERE page_id=? AND ${proof}`, page.id),
      stmt(
        c.env,
        `INSERT INTO wiki_page_grants(page_id,user_id,role) SELECT ?,json_extract(value,'$.user_id'),json_extract(value,'$.role') FROM json_each(?) WHERE ${proof}`,
        page.id,
        JSON.stringify(grants),
      ),
      stmt(
        c.env,
        `UPDATE wiki_pages SET permission_mode=?,version=version+1 WHERE id=? AND ${proof}`,
        data.permission_mode as string,
        page.id,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET acl_version=acl_version+1 WHERE id=? AND ${proof}`,
        space.id,
      ),
    ],
    { space: space.id, page: page.id, action: "page.shared" },
  );
  return c.json({ version: page.version + 1 });
});
for (const action of ["trash", "restore"] as const)
  wiki.post(`/pages/:id/${action}`, requirePermission("wiki.pages.delete"), async (c) => {
    const page = await getPage(c, c.req.param("id"), 3, action === "restore"),
      space = await getSpace(c, page.space_id),
      data = await body(c, ["version"]);
    if (version(data.version) !== page.version) fail(412, "wiki.changed");
    const actor = actorOf(c).user_id,
      checks = [
        pageCondition(actor, page.id, 3, action === "restore"),
        pageVersion(page),
        spaceVersion(space),
      ];
    if (action === "restore" && page.parent_id)
      checks.push(pageCondition(actor, page.parent_id, 3));
    if (action === "trash")
      checks.push(
        check(
          `NOT EXISTS(${actorCte} SELECT 1 FROM wiki_pages p JOIN wiki_spaces s ON s.id=p.space_id CROSS JOIN actor WHERE p.id IN(${subtree}) AND p.purged_at IS NULL AND ${pageRank()}<3)`,
          actor,
          page.id,
        ),
      );
    await mutate(
      c,
      "wiki.pages.delete",
      checks,
      (proof) => [
        stmt(
          c.env,
          `UPDATE wiki_pages SET trashed_at=${action === "trash" ? "unixepoch()" : "NULL"},version=version+1 WHERE id=? AND ${proof}`,
          page.id,
        ),
        stmt(
          c.env,
          `UPDATE wiki_spaces SET acl_version=acl_version+1,tree_version=tree_version+1 WHERE id=? AND ${proof}`,
          space.id,
        ),
      ],
      { space: space.id, page: page.id, action: `page.${action}` },
    );
    return c.json({ ok: true });
  });
wiki.delete("/pages/:id", requirePermission("wiki.pages.delete"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 4, true),
    space = await getSpace(c, page.space_id, 4);
  if (!page.trashed_at || version(Number(c.req.query("version"))) !== page.version)
    fail(412, "wiki.changed");
  await mutate(
    c,
    "wiki.pages.delete",
    [spaceCondition(actorOf(c).user_id, space.id, 4), pageVersion(page), spaceVersion(space)],
    (proof) => [
      stmt(
        c.env,
        `UPDATE collaboration_resources SET retired_at=unixepoch() WHERE id IN(SELECT resource_id FROM wiki_pages WHERE id IN(${subtree})) AND ${proof}`,
        page.id,
      ),
      stmt(
        c.env,
        `UPDATE wiki_pages SET purged_at=unixepoch(),title='',plain_text='',version=version+1 WHERE id IN(${subtree}) AND ${proof}`,
        page.id,
      ),
      stmt(
        c.env,
        `UPDATE wiki_spaces SET acl_version=acl_version+1,tree_version=tree_version+1 WHERE id=? AND ${proof}`,
        space.id,
      ),
    ],
    { space: space.id, page: page.id, action: "page.purged" },
  );
  return c.body(null, 204);
});
wiki.get("/pages/:id/comments", async (c) => {
  const page = await getPage(c, c.req.param("id"));
  return c.json({
    comments: await rows<WikiComment>(
      c.env,
      "SELECT c.*,COALESCE(u.display_name,u.email_address) AS author_name FROM wiki_comments c JOIN users u ON u.id=c.author_user_id WHERE c.page_id=? AND c.deleted_at IS NULL ORDER BY c.created_at,c.id LIMIT 200",
      page.id,
    ),
  });
});
wiki.post("/pages/:id/comments", requirePermission("wiki.comments.create"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 2),
    data = await body(c, ["body"]),
    comment = uuid();
  await mutate(
    c,
    "wiki.comments.create",
    [pageCondition(actorOf(c).user_id, page.id, 2)],
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO wiki_comments(id,page_id,author_user_id,body) SELECT ?,?,?,? WHERE ${proof}`,
        comment,
        page.id,
        actorOf(c).user_id,
        text(data.body, 10000),
      ),
    ],
  );
  return c.json({ id: comment }, 201);
});
wiki.patch(
  "/pages/:id/comments/:commentId",
  requirePermission("wiki.comments.create"),
  async (c) => {
    const page = await getPage(c, c.req.param("id"), 2),
      data = await body(c, ["body", "resolved", "version"]),
      comment = await row<WikiComment>(
        c.env,
        "SELECT * FROM wiki_comments WHERE id=? AND page_id=? AND deleted_at IS NULL",
        id(c.req.param("commentId")),
        page.id,
      );
    if (!comment) fail(404, "wiki.notFound");
    if (comment.author_user_id !== actorOf(c).user_id && page.role < 4) fail(403, "wiki.denied");
    if (data.resolved !== undefined && typeof data.resolved !== "boolean") fail(400);
    const content = data.body === undefined ? comment.body : text(data.body, 10000),
      resolved =
        data.resolved === undefined
          ? comment.resolved_at
          : data.resolved
            ? Math.floor(Date.now() / 1000)
            : null;
    await mutate(
      c,
      "wiki.comments.create",
      [
        pageCondition(
          actorOf(c).user_id,
          page.id,
          comment.author_user_id === actorOf(c).user_id ? 2 : 4,
        ),
        check(
          "EXISTS(SELECT 1 FROM wiki_comments WHERE id=? AND version=? AND deleted_at IS NULL)",
          comment.id,
          version(data.version),
        ),
      ],
      (proof) => [
        stmt(
          c.env,
          `UPDATE wiki_comments SET body=?,resolved_at=?,version=version+1,updated_at=unixepoch() WHERE id=? AND ${proof}`,
          content,
          resolved,
          comment.id,
        ),
      ],
    );
    return c.json({ ok: true });
  },
);
for (const method of ["put", "delete"] as const)
  wiki[method]("/pages/:id/favorite", async (c) => {
    const page = await getPage(c, c.req.param("id"));
    await mutate(c, "wiki.access", [pageCondition(actorOf(c).user_id, page.id)], (proof) => [
      method === "put"
        ? stmt(
            c.env,
            `INSERT INTO wiki_favorites(user_id,page_id) SELECT ?,? WHERE ${proof} ON CONFLICT DO NOTHING`,
            actorOf(c).user_id,
            page.id,
          )
        : stmt(
            c.env,
            `DELETE FROM wiki_favorites WHERE user_id=? AND page_id=? AND ${proof}`,
            actorOf(c).user_id,
            page.id,
          ),
    ]);
    return c.body(null, 204);
  });
wiki.get("/pages/:id/assets", async (c) => {
  const page = await getPage(c, c.req.param("id"));
  return c.json({
    assets: await rows(
      c.env,
      "SELECT id,filename,content_type,byte_size FROM wiki_assets WHERE page_id=? AND ready_at IS NOT NULL ORDER BY created_at,id",
      page.id,
    ),
  });
});
wiki.post("/pages/:id/assets", requirePermission("wiki.assets.upload"), async (c) => {
  const page = await getPage(c, c.req.param("id"), 3),
    filename = text(c.req.query("filename"), 255),
    bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) fail(413, "wiki.tooLarge");
  const asset = uuid(),
    key = `wiki/${page.space_id}/${page.id}/${asset}`,
    contentType = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0]!;
  // Reserve the object before uploading, so a crash leaves a discoverable cleanup record.
  await mutate(
    c,
    "wiki.assets.upload",
    [pageCondition(actorOf(c).user_id, page.id, 3)],
    (proof) => [
      stmt(
        c.env,
        `INSERT INTO wiki_assets(id,page_id,object_key,filename,content_type,byte_size,created_by) SELECT ?,?,?,?,?,?,? WHERE ${proof}`,
        asset,
        page.id,
        key,
        filename,
        contentType,
        bytes.byteLength,
        actorOf(c).user_id,
      ),
    ],
  );
  try {
    await c.env.WIKI_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    await mutate(
      c,
      "wiki.assets.upload",
      [
        pageCondition(actorOf(c).user_id, page.id, 3),
        check("EXISTS(SELECT 1 FROM wiki_assets WHERE id=? AND ready_at IS NULL)", asset),
      ],
      (proof) => [
        stmt(c.env, `UPDATE wiki_assets SET ready_at=unixepoch() WHERE id=? AND ${proof}`, asset),
      ],
    );
  } catch (error) {
    await c.env.WIKI_BUCKET.delete(key);
    await stmt(c.env, "DELETE FROM wiki_assets WHERE id=? AND ready_at IS NULL", asset).run();
    throw error;
  }
  return c.json(
    { asset: { id: asset, filename, byte_size: bytes.byteLength, content_type: contentType } },
    201,
  );
});
wiki.get("/pages/:id/assets/:assetId", async (c) => {
  const page = await getPage(c, c.req.param("id")),
    asset = await row<{ object_key: string; filename: string; content_type: string }>(
      c.env,
      "SELECT object_key,filename,content_type FROM wiki_assets WHERE id=? AND page_id=? AND ready_at IS NOT NULL",
      id(c.req.param("assetId")),
      page.id,
    );
  if (!asset) fail(404, "wiki.notFound");
  const object = await c.env.WIKI_BUCKET.get(asset.object_key);
  if (!object) fail(404, "wiki.notFound");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
export default wiki;
