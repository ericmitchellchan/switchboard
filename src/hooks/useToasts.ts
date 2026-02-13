import { useState, useCallback, useRef } from "react";

export interface ToastItem {
  id: string;
  sessionId: string;
  sessionName: string;
  message: string;
  createdAt: number;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const addToast = useCallback(
    (sessionId: string, sessionName: string, message: string, persistent = false) => {
      const id = `${sessionId}-${Date.now()}`;
      const toast: ToastItem = {
        id,
        sessionId,
        sessionName,
        message,
        createdAt: Date.now(),
      };

      setToasts((prev) => {
        // Don't add duplicate toast for same session if one already exists
        if (persistent && prev.some((t) => t.sessionId === sessionId)) {
          return prev;
        }
        return [...prev, toast];
      });

      if (!persistent) {
        // Auto-dismiss after 5s
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
          timersRef.current.delete(id);
        }, 5000);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissBySessionId = useCallback((sessionId: string) => {
    setToasts((prev) => {
      const keep: ToastItem[] = [];
      for (const t of prev) {
        if (t.sessionId === sessionId) {
          const timer = timersRef.current.get(t.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(t.id);
          }
        } else {
          keep.push(t);
        }
      }
      return keep;
    });
  }, []);

  return { toasts, addToast, dismissToast, dismissBySessionId };
}
