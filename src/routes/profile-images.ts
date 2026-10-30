import { t } from "../../shared/i18n/index.ts";
import { Hono } from "hono";
import { and, eq, exists, isNull } from "drizzle-orm";
import { conflict } from "../auth/input";
import { accessClaim, publicUser, requireAccess, throttle } from "../auth/store";
import { accessWon } from "../db/auth-conditions";
import { users } from "../db/schema";
import { now, uuid, type AppEnv } from "../auth/types";
import { inspectProfileImage, profileImagePrefix } from "../profile/images";
import { profileImageResponse } from "../profile/image-response";

const images = new Hono<AppEnv>();
images.use("/profile-image", requireAccess);

images.get("/profile-image", (c) => profileImageResponse(c, c.get("identity").user));

images.put("/profile-image", async (c) => {
  const { user, session } = c.get("identity"),
    db = c.get("db");
  await throttle(c, "profile-image", user.id);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const image = inspectProfileImage(
    bytes,
    c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "",
  );
  const key = `${profileImagePrefix(user.id)}${uuid()}.${image.extension}`,
    operation = uuid();
  const unchanged = exists(
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, user.id),
          user.profile_image_key === null
            ? isNull(users.profile_image_key)
            : eq(users.profile_image_key, user.profile_image_key),
        ),
      ),
  );
  await c.env.PROFILE_BUCKET.put(key, bytes, { httpMetadata: { contentType: image.mime } });
  try {
    const result = await db.batch([
      accessClaim(c, operation, unchanged),
      db
        .update(users)
        .set({ profile_image_key: key, updated_at: now() })
        .where(and(eq(users.id, user.id), accessWon(db, session.id, operation))),
    ]);
    if (result[1].meta.changes !== 1)
      conflict(t("routesProfileImages.accountOrProfileImageChangedReloadAndRetry"));
  } catch (failure) {
    await c.env.PROFILE_BUCKET.delete(key).catch(() => {});
    throw failure;
  }
  if (user.profile_image_key?.startsWith(profileImagePrefix(user.id)))
    c.executionCtx.waitUntil(c.env.PROFILE_BUCKET.delete(user.profile_image_key));
  const updated = await db.select().from(users).where(eq(users.id, user.id)).get();
  return c.json({ user: publicUser(updated!) });
});

images.delete("/profile-image", async (c) => {
  const { user, session } = c.get("identity"),
    db = c.get("db"),
    operation = uuid();
  await throttle(c, "profile-image", user.id);
  const unchanged = exists(
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, user.id),
          user.profile_image_key === null
            ? isNull(users.profile_image_key)
            : eq(users.profile_image_key, user.profile_image_key),
        ),
      ),
  );
  const result = await db.batch([
    accessClaim(c, operation, unchanged),
    db
      .update(users)
      .set({ profile_image_key: null, updated_at: now() })
      .where(and(eq(users.id, user.id), accessWon(db, session.id, operation))),
  ]);
  if (result[1].meta.changes !== 1)
    conflict(t("routesProfileImages.accountOrProfileImageChangedReloadAndRetry"));
  if (user.profile_image_key?.startsWith(profileImagePrefix(user.id)))
    c.executionCtx.waitUntil(c.env.PROFILE_BUCKET.delete(user.profile_image_key));
  const updated = await db.select().from(users).where(eq(users.id, user.id)).get();
  return c.json({ user: publicUser(updated!) });
});

export default images;
