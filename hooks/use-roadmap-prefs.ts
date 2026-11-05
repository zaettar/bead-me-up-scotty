"use client";
import * as React from "react";

const EVENT = "bmus.roadmap.changed";

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

function read(key: string): boolean {
  const session = sessionValues.get(key);
  if (session !== undefined) return session;
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function useStoredFlag(key: string) {
  const value = React.useSyncExternalStore(subscribe, () => read(key), () => false);
  const setValue = React.useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
        sessionValues.delete(key);
      } catch {
        sessionValues.set(key, next);
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, setValue] as const;
}

/** Whether Roadmap hides completed work, remembered per project in this browser. */
export const useHideCompleted = (projectId: string) =>
  useStoredFlag(`bmus.roadmap.hideCompleted.${projectId}`);

/** Whether the Next up rail is collapsed, remembered in this browser. */
export const useRailCollapsed = () => useStoredFlag("bmus.roadmap.railCollapsed");
