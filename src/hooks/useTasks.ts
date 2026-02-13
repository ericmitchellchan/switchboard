import { useState, useCallback, useEffect } from "react";
import type { Task } from "../types";

const STORAGE_KEY = "switchboard:tasks";

function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTasks(tasks: Task[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    // On mount, auto-clear completed tasks from previous sessions
    const loaded = loadTasks();
    return loaded.filter((t) => !t.done);
  });

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  const addTask = useCallback(
    (
      text: string,
      priority: Task["priority"] = "med",
      source: Task["source"] = "manual",
      repo?: string
    ) => {
      const task: Task = {
        id: crypto.randomUUID(),
        text,
        done: false,
        priority,
        source,
        repo,
        createdAt: Date.now(),
      };
      setTasks((prev) => [task, ...prev]);
    },
    []
  );

  const addAutoTask = useCallback(
    (
      detected: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string },
      sessionId: string,
      repo?: string
    ) => {
      setTasks((prev) => {
        // Dedup by fingerprint
        if (prev.some((t) => t.fingerprint === detected.fingerprint && !t.done)) {
          return prev;
        }
        const task: Task = {
          id: crypto.randomUUID(),
          text: detected.text,
          done: false,
          priority: detected.priority,
          source: "auto",
          repo,
          createdAt: Date.now(),
          sessionId,
          category: detected.category as Task["category"],
          fingerprint: detected.fingerprint,
        };
        return [task, ...prev];
      });
    },
    []
  );

  const resolveByFingerprint = useCallback((prefix: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.source === "auto" &&
        !t.done &&
        t.fingerprint?.startsWith(prefix)
          ? { ...t, done: true, autoResolved: true }
          : t
      )
    );
  }, []);

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setTasks((prev) => prev.filter((t) => !t.done));
  }, []);

  const activeTasks = tasks.filter((t) => !t.done);
  const completedTasks = tasks.filter((t) => t.done);
  const autoTasks = activeTasks.filter((t) => t.source === "auto");
  const manualTasks = activeTasks.filter((t) => t.source === "manual");

  return {
    tasks,
    activeTasks,
    completedTasks,
    autoTasks,
    manualTasks,
    addTask,
    addAutoTask,
    resolveByFingerprint,
    toggleTask,
    removeTask,
    clearCompleted,
  };
}
