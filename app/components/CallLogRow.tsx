"use client";

import React from "react";
import type { CallLogEntry } from "@/app/types";
import { parseTs, fmtDuration } from "@/app/utils/helpers";

// ─── CALL LOG ROW ─────────────────────────────────────────────────────────────
export function CallLogRow({ log }: { log: CallLogEntry }) {
  const isVideo = log.media === "video";
  return (
    <div className="pfs-call-item">
      <div className={`pfs-call-icon ${log.status === "missed" ? "missed" : log.direction}`}>
        {isVideo
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>}
      </div>
      <div className="pfs-call-info">
        <div className={`pfs-call-dir ${log.status === "missed" ? "missed" : ""}`}>
          {log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"} {isVideo ? "Video" : "Voice"}
          {log.status !== "completed" && <span style={{ fontSize: "0.65rem", marginLeft: 6, opacity: 0.7 }}>({log.status})</span>}
        </div>
        <div className="pfs-call-meta">
          {parseTs(log.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <div className="pfs-call-dur">{log.status === "completed" ? fmtDuration(log.duration) : log.status}</div>
    </div>
  );
}
