import { useRef } from "react";
import { Camera, X } from "lucide-react";
import { resizeAvatarFile } from "./avatarStore";
import { useI18n } from "./i18n";

type AvatarEditorProps = {
  name: string;
  /** Drives the initials fallback, which shows the first character. */
  address: string;
  /** Current picture data URL, or null to show the initials fallback. */
  current: string | null;
  disabled?: boolean;
  /** Called with the resized picture data URL, or null when cleared. */
  onChange: (dataUrl: string | null) => void;
};

/**
 * Circular avatar with hover-revealed edit affordances: a camera overlay picks
 * a new picture, and (when a picture exists) a corner badge removes it. Both
 * editors (contacts and accounts) share this control so the interaction is
 * identical: nothing visible until you point at the avatar.
 */
export function AvatarEditor({ name, address, current, disabled, onChange }: AvatarEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  const letter = (name.trim() || address.trim().split("@")[0] || "?").slice(0, 1).toUpperCase();
  return (
    <span className="avatar-editor">
      <span className="avatar-editor-disc" aria-hidden="true">
        {current ? (
          <img className="avatar-editor-image" src={current} alt="" />
        ) : (
          <span className="avatar-editor-letter">{letter}</span>
        )}
      </span>
      <button
        className="avatar-editor-choose"
        type="button"
        title={t("settings.avatars.custom.choose")}
        aria-label={t("settings.avatars.custom.choose")}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Camera size={16} />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void resizeAvatarFile(file).then((dataUrl) => {
            if (dataUrl) onChange(dataUrl);
          });
        }}
      />
      {current && (
        <button
          className="avatar-editor-clear"
          type="button"
          title={t("settings.avatars.custom.clear")}
          aria-label={t("settings.avatars.custom.clear")}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}