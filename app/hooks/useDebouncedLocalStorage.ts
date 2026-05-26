"use client";

import { useEffect } from "react";
import { useDebounce } from "./useDebounce";

// ─── useDebouncedLocalStorage ─────────────────────────────────────────────────
export function useDebouncedLocalStorage(key: string, value: unknown, delay = 800) {
  const debouncedValue = useDebounce(value, delay);
  useEffect(() => {
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(debouncedValue)); } catch { }
    }
  }, [key, debouncedValue]);
}
