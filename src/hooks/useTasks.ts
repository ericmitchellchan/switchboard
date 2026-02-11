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
  const [tasks, setTasks] = useState<Task[]>(loadTasks);

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

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const activeTasks = tasks.filter((t) => !t.done);
  const completedTasks = tasks.filter((t) => t.done);

  return { tasks, activeTasks, completedTasks, addTask, toggleTask, removeTask };
}
