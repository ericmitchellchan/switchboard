import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
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
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  // Soft palette: the non-destructive primary action is a white button
  // (zinc chrome, no brand color); destructive stays functional red.
  const confirmBg = destructive ? "#EF4444" : "#E4E4E7";
  const confirmHoverBg = destructive ? "#DC2626" : "#FAFAFA";
  const confirmFg = destructive ? "#FFFFFF" : "#0C0C0E";

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
          width: 360,
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
