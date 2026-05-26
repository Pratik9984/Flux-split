"use client";

import React, { useRef, memo } from "react";
import type { Contact } from "@/app/types";
import { formatTimeAgo } from "@/app/utils/helpers";

// ─── CONTACT ITEM ─────────────────────────────────────────────────────────────
interface ContactItemProps {
  contact: Contact; isActive: boolean; isDeleteTarget: boolean;
  unreadCount: number; lastPreview: string; label: string;
  nickname?: string; lastActivityTs: number;
  onOpen: () => void; onDelete: () => void;
  onDeleteTarget: (id: string) => void; onClearDelete: () => void;
  isChatMuted: (chatId: string) => boolean;
  onOpenProfile?: () => void;
}
export const ContactItem = memo(function ContactItem({
  contact: c, isActive, isDeleteTarget, unreadCount, lastPreview,
  label, nickname, lastActivityTs, onOpen, onDelete, onDeleteTarget,
  onClearDelete, isChatMuted, onOpenProfile,
}: ContactItemProps) {
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnread = unreadCount > 0;
  const timeLabel = formatTimeAgo(lastActivityTs);

  return (
    <div
      className="sb-item-wrap"
      onTouchStart={() => { longPressRef.current = setTimeout(() => onDeleteTarget(c.email), 500); }}
      onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onTouchMove={() => { if (longPressRef.current) clearTimeout(longPressRef.current); }}
      onContextMenu={e => { e.preventDefault(); onDeleteTarget(c.email); }}
    >
      <button
        onClick={() => { if (isDeleteTarget) { onClearDelete(); return; } onOpen(); }}
        className={`sb-item ${isActive ? "sb-item--active" : ""} ${hasUnread && !isActive ? "sb-item--unread" : ""}`}
      >
        <div className="sb-av" onClick={e => { e.stopPropagation(); onOpenProfile?.(); }}>
          {c.avatar_url
            ? <img src={c.avatar_url} alt="avatar" className="img-cover rounded-circle" />
            : label?.[0]?.toUpperCase() || "?"}
          <span className={`pres ${c.is_online ? "pres--on" : ""}`} />
        </div>
        <div className="sb-item-body mw-0">
          <span className="sb-item-name name-row">
            {nickname
              ? <><span>{nickname}</span><span className="name-meta">({c.display_name || (c.username ? `@${c.username}` : "")})</span></>
              : <span>{label}</span>}
          </span>
          <span className={`sb-item-status text-truncate ${hasUnread ? "sb-item-status--unread" : ""}`}>
            {lastPreview
              ? lastPreview.substring(0, 34) + (lastPreview.length > 34 ? "…" : "")
              : c.username
                ? <span style={{ opacity: 0.5 }}>@{c.username}</span>
                : <span className={c.is_online ? "online" : ""}>{c.is_online ? "● Online" : "○ Offline"}</span>}
          </span>
        </div>
        <div className="sb-item-right">
          {isChatMuted(c.email) && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" style={{ opacity: 0.55 }}>
              <path d="M13.73 21a2 2 0 01-3.46 0" /><path d="M18.63 13A17.9 17.9 0 0118 8" />
              <path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14" />
              <path d="M18 8a6 6 0 00-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          )}
          {timeLabel && <span className="sb-item-time">{timeLabel}</span>}
          {hasUnread && (
            <span className="unread unread--dm" style={{ minWidth: 20, height: 20, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, padding: "0 5px" }}>
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
