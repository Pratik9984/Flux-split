"use client";

import React from "react";
import type { Message, Contact, Chat } from "@/app/types";

interface ForwardPickerProps {
  showForwardPicker: boolean;
  forwardingMsgs: Message[];
  onClose: () => void;
  sortedChats: any[];
  contacts: Contact[];
  contactLabel: (c: Contact) => string;
  forwardSelectedTargets: { type: "user" | "group"; id: string | number; name: string }[];
  toggleForwardTarget: (target: { type: "user" | "group"; id: string | number; name: string }) => void;
  handleMultiForward: () => void;
}

export function ForwardPicker({
  showForwardPicker,
  forwardingMsgs,
  onClose,
  sortedChats,
  contacts,
  contactLabel,
  forwardSelectedTargets,
  toggleForwardTarget,
  handleMultiForward,
}: ForwardPickerProps) {
  if (!showForwardPicker || forwardingMsgs.length === 0) return null;

  return (
    <div className="file-viewer-overlay" style={{ zIndex: 10001 }} onClick={onClose}>
      <div className="viewer-content cl-modal" style={{ maxHeight: "75vh", display: "flex", flexDirection: "column", padding: 0 }} onClick={e => e.stopPropagation()}>
        <div className="cl-header" style={{ flexShrink: 0 }}>
          <h2 className="cl-title">Forward to…</h2>
          <button className="cl-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "10px 16px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span>↗</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {forwardingMsgs.length === 1 ? (forwardingMsgs[0].content.startsWith("[") ? "📎 Attachment" : forwardingMsgs[0].content) : `Forwarding ${forwardingMsgs.length} messages`}
          </span>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {sortedChats.length > 0 && (
            <>
              <div style={{ padding: "8px 16px 4px", fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Chats</div>
              {sortedChats.map(chat => {
                if (chat.type === "user") {
                  const c = chat.item;
                  const targetId = c.email;
                  const isSel = forwardSelectedTargets.some(t => String(t.id) === String(targetId));
                  return (
                    <button
                      key={c.email}
                      className={`sb-item ${isSel ? "sb-item--active" : ""}`}
                      style={{ width: "100%", borderRadius: 0, borderBottom: "1px solid var(--border-2)", position: "relative" }}
                      onClick={() => toggleForwardTarget({ type: "user", id: targetId, name: contactLabel(c) })}
                    >
                      <div className="sb-av">
                        {c.avatar_url ? <img src={c.avatar_url} className="img-cover rounded-circle" alt="av" /> : contactLabel(c)[0]?.toUpperCase() || "?"}
                        <span className={`pres ${c.is_online ? "pres--on" : ""}`} />
                        {isSel && <div className="checkbox-av-overlay">✓</div>}
                      </div>
                      <div className="sb-item-body mw-0">
                        <span className="sb-item-name">{contactLabel(c)}</span>
                        {c.username && <span className="sb-item-status">@{c.username}</span>}
                      </div>
                    </button>
                  );
                } else {
                  const g = chat.item;
                  const targetId = g.id;
                  const isSel = forwardSelectedTargets.some(t => String(t.id) === String(targetId));
                  return (
                    <button
                      key={g.id}
                      className={`sb-item ${isSel ? "sb-item--active-group" : ""}`}
                      style={{ width: "100%", borderRadius: 0, borderBottom: "1px solid var(--border-2)", position: "relative" }}
                      onClick={() => toggleForwardTarget({ type: "group", id: targetId, name: g.name })}
                    >
                      <div className="sb-av sb-av--group">
                        {g.avatar_url ? <img src={g.avatar_url} className="img-cover rounded-circle" alt="av" /> : g.name[0]?.toUpperCase() || "?"}
                        {isSel && <div className="checkbox-av-overlay">✓</div>}
                      </div>
                      <div className="sb-item-body mw-0">
                        <span className="sb-item-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="text-truncate" style={{ flexShrink: 1 }}>{g.name}</span>
                          <span className="group-badge" style={{ flexShrink: 0 }}>Group</span>
                        </span>
                        <span className="sb-item-status">{g.members.length} members</span>
                      </div>
                    </button>
                  );
                }
              })}
            </>
          )}
        </div>
        {forwardSelectedTargets.length > 0 && (
          <div className="forward-actions-bar" style={{ flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>
              Selected {forwardSelectedTargets.length} {forwardSelectedTargets.length === 1 ? "chat" : "chats"}
            </span>
            <button className="mp-send-btn" onClick={handleMultiForward} style={{ minHeight: 38, padding: "8px 20px" }}>
              Send ➤
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
