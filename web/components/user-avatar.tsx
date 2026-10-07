import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AdminUser } from "../lib/console";
import { useSession } from "../lib/session";

export function UserAvatar({ user }: { user: AdminUser }) {
  const sessionId = useSession().session?.tokens.session_id;
  const [photo, setPhoto] = useState<{ id: string; key: string; sessionId: string | undefined; url: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setPhoto(null);
    if (user.profile_image_key) void api<Blob>(`/api/users/${encodeURIComponent(user.id)}/profile-image`, {
      response: "blob", signal: controller.signal,
    }).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPhoto({ id: user.id, key: user.profile_image_key!, sessionId, url });
    }).catch(() => { /* Show initials when the photo is missing or unavailable. */ });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [user.id, user.profile_image_key, sessionId]);
  const imageUrl = photo?.id === user.id && photo.key === user.profile_image_key && photo.sessionId === sessionId ? photo.url : null;
  const name = user.display_name || user.email_address;
  return <span className="console-avatar" aria-hidden="true">
    {imageUrl ? <img src={imageUrl} alt="" decoding="async" onError={() => setPhoto(null)} /> : name.slice(0, 1).toUpperCase()}
  </span>;
}
