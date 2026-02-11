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
    (sessionId: string, sessionName: string, message: string) => {
      const id = `${sessionId}-${Date.now()}`;
      const toast: ToastItem = {
        id,
        sessionId,
        sessionName,
        message,
        createdAt: Date.now(),
      };

      setToasts((prev) => [...prev, toast]);

      // Auto-dismiss after 5s
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timersRef.current.delete(id);
      }, 5000);
      timersRef.current.set(id, timer);

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

  return { toasts, addToast, dismissToast };
}
