import { useEffect, useRef } from "react";

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

  // Soft palette: the non-destructive primary action is a light button
  // (warm-grey chrome, no brand color); destructive is the rose tone — light
  // enough that BOTH variants take the dark fg.
  const confirmBg = destructive ? "var(--accent-red)" : "var(--text-primary)";
  const confirmHoverBg = destructive ? "#d97878" : "#FAFAFA";
  const confirmFg = "var(--bg-primary)";

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
          // Wider when there are more than two outcomes: four mono buttons on
          // one row need the room, and the footer wraps below that.
          width: extraActions && extraActions.length > 0 ? 420 : 360,
          maxWidth: "calc(100vw - 32px)",
          backgroundColor: "var(--bg-active)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          zIndex: 200,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          id="confirm-dialog-title"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
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
          <button
            ref={cancelRef}
            onClick={onCancel}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text-primary)",
              backgroundColor: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "6px 14px",
              cursor: "pointer",
              outline: "none",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--text-secondary)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            {cancelLabel}
          </button>
          {extraActions?.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--text-primary)",
                backgroundColor: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "6px 14px",
                cursor: "pointer",
                outline: "none",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--text-secondary)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {action.label}
            </button>
          ))}
          <button
            onClick={onConfirm}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: confirmFg,
              backgroundColor: confirmBg,
              border: "1px solid transparent",
              borderRadius: 4,
              padding: "6px 14px",
              cursor: "pointer",
              outline: "none",
              transition: "background-color 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = confirmHoverBg;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = confirmBg;
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
