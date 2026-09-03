import type { ToastItem } from "../hooks/useToasts";

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onClickToast: (sessionId: string) => void;
}

export function ToastStack({ toasts, onDismiss, onClickToast }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 34, // above StatusBar
        right: 16,
        zIndex: 100,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onClick={() => {
            onClickToast(toast.sessionId);
            onDismiss(toast.id);
          }}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            backgroundColor: "var(--bg-active)",
            border: "1px solid #E8B76533",
            borderRadius: 6,
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            animation: "slide-in-right 0.25s ease-out",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            maxWidth: 320,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: "var(--accent-yellow)",
              flexShrink: 0,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {toast.sessionName}
            </span>
            <span
              style={{
                fontSize: 10,
                color: "var(--accent-yellow)",
              }}
            >
              {toast.message}
            </span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-dim)",
              fontSize: 12,
              padding: "0 2px",
              marginLeft: "auto",
              flexShrink: 0,
            }}
          >
            {"\u2715"}
          </button>
        </div>
      ))}
    </div>
  );
}
