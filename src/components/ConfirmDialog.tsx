import { useEffect, useRef, useState } from "react";
import { READING, PRIMARY, QUIET_BUTTON } from "./kit";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Does Enter fire the confirm button? Default TRUE — that is right for the
   *  session-close callers, where the dialog stands between the user and a
   *  routine action and Enter is a courtesy.
   *
   *  FALSE for thread delete (increment E, Decision 3): the dialog's safety is
   *  that the destructive button cannot be reached by reflex. Cancel already
   *  holds focus, so with Enter unbound here the key does nothing worse than
   *  cancel — and cancelling changes nothing. Esc still cancels either way. */
  enterConfirms?: boolean;
  /** EXTRA non-destructive choices, rendered between Cancel and the confirm
   *  button (increment H). A dialog with more than two outcomes is rare and
   *  should stay rare — the panel-terminal close guard has three real ones
   *  (keep running / promote to tab / kill) and offering only two would force
   *  a lie into one of the labels. Cancel is still the focused button and Esc
   *  still cancels, so the extra choices cannot be hit by reflex either. */
  extraActions?: Array<{ label: string; onClick: () => void }>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Close",
  cancelLabel = "Cancel",
  destructive = true,
  enterConfirms = true,
  extraActions,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter" && enterConfirms) {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onCancel, onConfirm, enterConfirms]);

  if (!open) return null;

  // Ky's shapes (SWIT-91): the confirm button is the page's PRIMARY (accent
  // fill) for a non-destructive outcome, the same shape in `--tone-rose`
  // for a destructive one — both take `--bg-primary` text, both readable.
  const confirmStyle = destructive ? { ...PRIMARY, background: "var(--tone-rose)" } : PRIMARY;

  return (
    <>
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
          zIndex: 199,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          // Wider when there are more than two outcomes: four buttons on one
          // row need the room, and the footer wraps below that.
          width: extraActions && extraActions.length > 0 ? 420 : 360,
          maxWidth: "calc(100vw - 32px)",
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          zIndex: 200,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          id="confirm-dialog-title"
          style={{
            fontFamily: READING,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: READING,
            fontSize: 12.5,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {message}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 4,
          }}
        >
          <QuietButton buttonRef={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </QuietButton>
          {extraActions?.map((action) => (
            <QuietButton key={action.label} onClick={action.onClick}>
              {action.label}
            </QuietButton>
          ))}
          <button
            onClick={onConfirm}
            style={confirmStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "0.9";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}

/** The quiet/cancel shape (kit.QUIET_BUTTON): transparent, a hairline,
 *  `--text-secondary` — brightens to `--text-primary` on hover/focus, the
 *  same affordance the old form gave. */
function QuietButton({
  onClick,
  buttonRef,
  children,
}: {
  onClick: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  const [hot, setHot] = useState(false);
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      style={{
        ...QUIET_BUTTON,
        outline: "none",
        color: hot ? "var(--text-primary)" : QUIET_BUTTON.color,
        borderColor: hot ? "var(--text-secondary)" : "var(--border-subtle)",
      }}
    >
      {children}
    </button>
  );
}
