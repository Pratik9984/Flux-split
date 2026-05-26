"use client";

import React, { useRef, memo } from "react";
import type { Group } from "@/app/types";
import { formatTimeAgo } from "@/app/utils/helpers";

// ─── GROUP ITEM ───────────────────────────────────────────────────────────────
interface GroupItemProps {
  group: Group; isActive: boolean; isDeleteTarget: boolean;
  unreadCount: number; lastPreview: string; lastActivityTs: number;
  onOpen: () => void; onDelete: () => void;
  onDeleteTarget: (id: string) => void; onClearDelete: () => void;
  isChatMuted: (chatId: string) => boolean;
  onOpenProfile?: () => void;
}
export const GroupItem = memo(function GroupItem({
  group: g, isActive, isDeleteTarget, unreadCount, lastPreview,
  lastActivityTs, onOpen, onDelete, onDeleteTarget, onClearDelete,
  isChatMuted, onOpenProfile,
}: GroupItemProps) {
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnread = unreadCount > 0;
  const sid = String(g.id);
  const timeLabel = formatTimeAgo(lastActivityTs);

  return (
    <div
      className="sb-item-wrap"
      onTouchStart={() => { longPressRef.current = setTimeout(() => onDeleteTarget(sid), 500); }}
      onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onContextMenu={e => { e.preventDefault(); onDeleteTarget(sid); }}
    >
      <button
        onClick={() => { if (isDeleteTarget) { onClearDelete(); return; } onOpen(); }}
        className={`sb-item ${isActive ? "sb-item--active-group" : ""} ${hasUnread && !isActive ? "sb-item--unread" : ""}`}
      >
        <div className="sb-av sb-av--group" onClick={e => { e.stopPropagation(); onOpenProfile?.(); }}>
          {g.avatar_url
            ? <img src={g.avatar_url} alt="group" className="img-cover rounded-circle" />
            : g.name?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="sb-item-body mw-0">
          <span className="sb-item-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="text-truncate" style={{ flexShrink: 1 }}>{g.name}</span>
            <span className="group-badge" style={{ flexShrink: 0 }}>Group</span>
          </span>
          <span className={`sb-item-status text-truncate ${hasUnread ? "sb-item-status--unread" : ""}`}>
            {lastPreview
              ? lastPreview.substring(0, 34) + (lastPreview.length > 34 ? "…" : "")
              : `${g.members.length} members`}
          </span>
        </div>
        <div className="sb-item-right">
          {isChatMuted(String(g.id)) && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" style={{ opacity: 0.55 }}>
              <path d="M13.73 21a2 2 0 01-3.46 0" /><path d="M18.63 13A17.9 17.9 0 0118 8" />
              <path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14" />
              <path d="M18 8a6 6 0 00-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          )}
          {timeLabel && <span className="sb-item-time">{timeLabel}</span>}
          {hasUnread && (
            <span className="unread unread--secondary" style={{ minWidth: 20, height: 20, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, padding: "0 5px" }}>
              {unreadCount}
            </span>
          )}
        </div>
      </button>
      {isDeleteTarget && (
        <button className="sb-delete-btn" onClick={e => { e.stopPropagation(); onDelete(); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          </svg>
          Delete
        </button>
      )}
    </div>
  );
});
