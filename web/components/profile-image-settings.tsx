import { useRef, useState } from "react";
import { Button, Dialog, DialogPopup, Icon } from "@/components/ui";
import { api, errorMessage, type AccountUser } from "../lib/api";
import { profilePhotoFileLimit } from "../lib/profile-image";
import { useAccount } from "./account-context";
import { AccountAvatar } from "./account-avatar";
import { ProfileImageEditor } from "./profile-image-editor";

export function ProfileImageSettings() {
  const { user, update } = useAccount();
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function save(photo: Blob) {
    const result = await api<{ user: AccountUser }>("/api/me/profile-image", { method: "PUT", body: photo });
    update(result.user); setError(""); setSuccess("Your profile photo has been saved.");
  }

  async function deletePhoto() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setSuccess("");
    try {
      const result = await api<{ user: AccountUser }>("/api/me/profile-image", { method: "DELETE" });
      update(result.user); setRemove(false); setSuccess("Your profile photo has been removed.");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="account-panel">
    <div className="account-panel-header"><h2>Profile photo</h2><p>Choose a PNG, JPEG or WebP image up to 10 MB. Adjust it before saving.</p></div>
    <div className="account-photo-settings"><AccountAvatar className="account-photo-avatar" /><div className="account-photo-settings-actions">
      <Button type="button" disabled={!user || busy} onClick={() => input.current?.click()}>{user?.profile_image_key ? "Change photo" : "Choose photo"}</Button>
      {user?.profile_image_key && <Button type="button" disabled={busy} onClick={() => { setError(""); setRemove(true); }}>Remove photo</Button>}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="account-photo-file" aria-label="Choose profile photo"
        onChange={(event) => {
          const selected = event.target.files?.[0]; event.target.value = "";
          if (!selected) return;
          setError(""); setSuccess("");
          if (!/^(image\/png|image\/jpeg|image\/webp)$/.test(selected.type) || selected.size > profilePhotoFileLimit) {
            setError("Choose a PNG, JPEG or WebP image up to 10 MB."); return;
          }
          setFile(selected);
        }} />
    </div></div>
    {error && <p className="account-notice" data-error role="alert"><Icon name="info" />{error}</p>}
    {success && <p className="account-notice" data-success role="status"><Icon name="check" />{success}</p>}
    <ProfileImageEditor file={file} onClose={() => setFile(null)} onSave={save} />
    <Dialog.Root open={remove} onOpenChange={(open) => { if (!inFlight.current) setRemove(open); }}>
      <DialogPopup><Dialog.Title>Remove your profile photo?</Dialog.Title><Dialog.Description>Your initials will be shown in its place.</Dialog.Description>
        {error && <p className="account-notice" data-error role="alert">{error}</p>}
        <div className="account-actions"><Button disabled={busy} onClick={() => setRemove(false)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => { void deletePhoto(); }}>{busy ? "Removing…" : "Remove photo"}</Button></div>
      </DialogPopup>
    </Dialog.Root>
  </section>;
}
