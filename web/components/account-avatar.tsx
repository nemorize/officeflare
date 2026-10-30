import { t } from "../../shared/i18n/index.ts";
import { useAccount } from "./account-context";
import { useSession } from "../lib/session";

export function AccountAvatar({ name, className = "" }: { name?: string; className?: string }) {
  const { user, imageUrl } = useAccount();
  const auth = useSession();
  const display =
    name ||
    user?.display_name ||
    user?.email_address ||
    auth.session?.email ||
    t("common.officeflare");
  return (
    <span className={`workspace-avatar ${className}`} aria-hidden="true">
      {imageUrl ? (
        <img src={imageUrl} alt="" />
      ) : (
        (display[0] ?? t("componentsAccountAvatar.o")).toUpperCase()
      )}
    </span>
  );
}
