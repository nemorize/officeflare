import { t } from "../../shared/i18n/index.ts";
import { useRef, useState } from "react";
import { Button, Dialog, DialogPopup, useNotifications } from "@/components/ui";
import { api, errorMessage, type AccountUser } from "../lib/api";
import { profilePhotoFileLimit } from "../lib/profile-image";
import { useAccount } from "./account-context";
import { AccountAvatar } from "./account-avatar";
import { ProfileImageEditor } from "./profile-image-editor";

export function ProfileImageSettings() {
  const notify = useNotifications();
  const { user, update } = useAccount();
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(photo: Blob) {
    const result = await api<{ user: AccountUser }>("/api/me/profile-image", {
      method: "PUT",
      body: photo,
    });
    update(result.user);
    notify.success(t("componentsProfileImageSettings.yourProfilePhotoHasBeenSaved"));
  }

  async function deletePhoto() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await api<{ user: AccountUser }>("/api/me/profile-image", {
        method: "DELETE",
      });
      update(result.user);
      setRemove(false);
      notify.success(t("componentsProfileImageSettings.yourProfilePhotoHasBeenRemoved"));
    } catch (failure) {
      notify.error(errorMessage(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="account-panel">
      <div className="account-panel-header">
        <h2>{t("componentsProfileImageSettings.profilePhoto")}</h2>
        <p>{t("componentsProfileImageSettings.chooseAPngJpegOrWebpImageUpTo")}</p>
      </div>
      <div className="account-photo-settings">
        <AccountAvatar className="account-photo-avatar" />
        <div className="account-photo-settings-actions">
          <Button type="button" disabled={!user || busy} onClick={() => input.current?.click()}>
            {user?.profile_image_key
              ? t("componentsProfileImageSettings.changePhoto")
              : t("componentsProfileImageSettings.choosePhoto")}
          </Button>
          {user?.profile_image_key && (
            <Button type="button" disabled={busy} onClick={() => setRemove(true)}>
              {t("componentsProfileImageSettings.removePhoto")}
            </Button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="account-photo-file"
            aria-label={t("componentsProfileImageSettings.chooseProfilePhoto")}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = "";
              if (!selected) return;
              if (
                !/^(image\/png|image\/jpeg|image\/webp)$/.test(selected.type) ||
                selected.size > profilePhotoFileLimit
              ) {
                notify.error(t("componentsProfileImageSettings.chooseAPngJpegOrWebpImageUpTo2"));
                return;
              }
              setFile(selected);
            }}
          />
        </div>
      </div>
      <ProfileImageEditor file={file} onClose={() => setFile(null)} onSave={save} />
      <Dialog.Root
        open={remove}
        onOpenChange={(open) => {
          if (!inFlight.current) setRemove(open);
        }}
      >
        <DialogPopup>
          <Dialog.Title>{t("componentsProfileImageSettings.removeYourProfilePhoto")}</Dialog.Title>
          <Dialog.Description>
            {t("componentsProfileImageSettings.yourInitialsWillBeShownInItsPlace")}
          </Dialog.Description>
          <div className="account-actions">
            <Button disabled={busy} onClick={() => setRemove(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                void deletePhoto();
              }}
            >
              {busy
                ? t("componentsProfileImageSettings.removing")
                : t("componentsProfileImageSettings.removePhoto")}
            </Button>
          </div>
        </DialogPopup>
      </Dialog.Root>
    </section>
  );
}
