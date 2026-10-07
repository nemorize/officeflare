import { HTTPException } from "hono/http-exception";
import type { AuthContext, User } from "../auth/types";
import { profileImagePrefix } from "./images";

export async function profileImageResponse(c: AuthContext, user: Pick<User, "id" | "profile_image_key">) {
  const key = user.profile_image_key;
  if (!key?.startsWith(profileImagePrefix(user.id))) throw new HTTPException(404, { message: "No profile image" });
  const object = await c.env.PROFILE_BUCKET.get(key);
  const contentType = object?.httpMetadata?.contentType;
  if (!object || !contentType || !["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new HTTPException(404, { message: "No profile image" });
  }
  c.header("Content-Type", contentType);
  c.header("Content-Disposition", "inline");
  return c.body(object.body);
}
