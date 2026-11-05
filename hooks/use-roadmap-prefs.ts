"use client";
import * as React from "react";

const EVENT = "bmus.roadmap.changed";
const keyFor = (projectId: string) => `bmus.roadmap.hideCompleted.${projectId}`;

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

// Kept for the session if storage is unavailable, so the toggle still works.
const sessionValues = new Map<string, boolean>();

function read(projectId: string): boolean {
  const session = sessionValues.get(projectId);
  if (session !== undefined) return session;
  try {
    return globalThis.localStorage?.getItem(keyFor(projectId)) === "1";
  } catch {
    return false;
  }
}

/** Whether Roadmap hides completed work, remembered per project in this browser. */
export function useHideCompleted(projectId: string) {
  const hideCompleted = React.useSyncExternalStore(subscribe, () => read(projectId), () => false);
  const setHideCompleted = React.useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(keyFor(projectId), next ? "1" : "0");
        sessionValues.delete(projectId);
      } catch {
        sessionValues.set(projectId, next);
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [projectId],
  );
  return [hideCompleted, setHideCompleted] as const;
}
