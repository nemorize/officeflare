import { t } from "../../shared/i18n/index.ts";
import type { ReactNode } from "react";
import { useAccount } from "./account-context";
import type { DriveItem } from "../lib/drive";
import { PersonAvatar as DrivePersonAvatar, PersonPhotosProvider } from "./person-avatar";
export { DrivePersonAvatar };
export function DriveOwnerPhotosProvider({ children }: { children: ReactNode }) {
  return <PersonPhotosProvider basePath="/api/drive/people">{children}</PersonPhotosProvider>;
}
export function DriveOwner({ item }: { item: DriveItem }) {
  const account = useAccount(),
    own = item.owner_user_id === account.user?.id;
  const name =
    (own ? account.user?.display_name || account.user?.email_address : null) ||
    item.owner?.display_name ||
    item.owner?.email_address ||
    t("componentsDriveOwner.sharedAccount");
  const person = item.owner ?? { id: item.owner_user_id, display_name: name, email_address: "" };
  return (
    <>
      <DrivePersonAvatar person={person} className="drive-owner-avatar" />
      <span className="drive-owner-name" title={name}>
        {name}
      </span>
    </>
  );
}
