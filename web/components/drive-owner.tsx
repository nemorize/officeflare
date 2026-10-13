import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount } from "./account-context";
import { useSession } from "../lib/session";
import { api } from "../lib/api";
import type { DriveItem, DrivePerson } from "../lib/drive";

function ownerPhotos() {
  const entries = new Map<string, Promise<string | null>>(), controllers = new Set<AbortController>(), urls = new Set<string>();
  let generation = 0;
  return {
    load(id: string, version: string | null | undefined) {
      const key = `${id}:${version ?? ""}`;
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController(), current = generation;
        controllers.add(controller);
        entry = api<Blob>(`/api/drive/people/${encodeURIComponent(id)}/profile-image`, { response: "blob", signal: controller.signal }).then(blob => {
          if (controller.signal.aborted || generation !== current) return null;
          const url = URL.createObjectURL(blob); urls.add(url); return url;
        }).catch(() => null).finally(() => controllers.delete(controller));
        entries.set(key, entry);
      }
      return entry;
    },
    clear() {
      generation++;
      for (const controller of controllers) controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      controllers.clear(); urls.clear(); entries.clear();
    },
  };
}
const Photos = createContext<ReturnType<typeof ownerPhotos> | null>(null);
export function DriveOwnerPhotosProvider({ children }: { children: ReactNode }) {
  const session = useSession().session?.tokens.session_id;
  const cache = useMemo(ownerPhotos, [session]);
  useEffect(() => () => cache.clear(), [cache]);
  return <Photos value={cache}>{children}</Photos>;
}
export function DrivePersonAvatar({ person, className = "drive-person-avatar" }: { person: DrivePerson | undefined; className?: string }) {
  const account = useAccount(), cache = useContext(Photos);
  const own = !!person && person.id === account.user?.id;
  const name = (own ? account.user?.display_name || account.user?.email_address : null) || person?.display_name || person?.email_address || "U";
  const version = person?.profile_image_version;
  const [photo, setPhoto] = useState<{ cache: typeof cache; id: string; version: string | null | undefined; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    setPhoto(null);
    if (!own && person?.has_profile_image && cache) void cache.load(person.id, version).then(url => {
      if (active && url) setPhoto({ cache, id: person.id, version, url });
    });
    return () => { active = false; };
  }, [own, person?.id, person?.has_profile_image, version, cache]);
  const imageUrl = own ? account.imageUrl : photo?.cache === cache && photo?.id === person?.id && photo?.version === version ? photo?.url : null;
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={className} aria-hidden="true">{imageUrl && failed !== imageUrl ? <img src={imageUrl} alt="" decoding="async" onError={() => setFailed(imageUrl)} /> : name.slice(0, 1).toUpperCase()}</span>;
}
export function DriveOwner({ item }: { item: DriveItem }) {
  const account = useAccount(), own = item.owner_user_id === account.user?.id;
  const name = (own ? account.user?.display_name || account.user?.email_address : null) || item.owner?.display_name || item.owner?.email_address || "Shared account";
  const person = item.owner ?? { id: item.owner_user_id, display_name: name, email_address: "" };
  return <><DrivePersonAvatar person={person} className="drive-owner-avatar" /><span className="drive-owner-name" title={name}>{name}</span></>;
}
