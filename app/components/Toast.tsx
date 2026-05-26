"use client";

import React from "react";

interface ToastProps {
  toast: { message: string; type: "success" | "error" | "info" } | null;
}

export function Toast({ toast }: ToastProps) {
  if (!toast) return null;

  return (
    <div className="toast-container">
      <div className={`toast-notification toast-notification--${toast.type}`}>
        <span className="toast-icon">
          {toast.type === "success" && "✓"}
          {toast.type === "error" && "✕"}
          {toast.type === "info" && "ℹ"}
        </span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
