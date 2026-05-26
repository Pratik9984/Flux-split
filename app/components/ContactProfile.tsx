"use client";

import React, { useState, useMemo } from "react";
import type { Contact, Chat, CallLogEntry, Message, ProfileTab } from "@/app/types";
import { CallLogRow } from "./CallLogRow";

// ─── CONTACT PROFILE ──────────────────────────────────────────────────────────
interface ContactProfileProps {
  contact: Contact | undefined; activeChat: Chat; currentUser: string;
  nicknames: Record<string, string>; contactLabel: (c: Contact) => string;
  callLogs: CallLogEntry[]; messagesCache: Record<string, Message[]>;
  onClose: () => void; onCall: (video: boolean) => void;
  onNicknameEdit: () => void; getPeerName: (email: string) => string;
  onViewFile: (url: string, type: string) => void;
  isBlocked: boolean; onBlock: () => void; onUnblock: () => void;
}
export function ContactProfile({
  contact: c, activeChat, nicknames, contactLabel, callLogs,
  messagesCache, onClose, onCall, onNicknameEdit, onViewFile,
  isBlocked, onBlock, onUnblock,
}: ContactProfileProps) {
  const [tab, setTab] = useState<ProfileTab>("info");
  const label = c ? contactLabel(c) : activeChat.name;
  const avatarUrl = c?.avatar_url;

  const sharedMedia = useMemo(() => {
    const msgs = messagesCache[String(activeChat.id)] || [];
    return msgs
      .filter(m => m.content.startsWith("[IMAGE]") || m.content.startsWith("[VIDEO]"))
      .map(m => ({
        url: m.content.replace(/^\[IMAGE\]|\[VIDEO\]/, ""),
        type: m.content.startsWith("[IMAGE]") ? "image" : "video",
        ts: m.timestamp,
      }));
  }, [messagesCache, activeChat.id]);

  const myCallLogs = useMemo(
    () => callLogs.filter(l => l.peer === String(activeChat.id)),
    [callLogs, activeChat.id],
  );

  return (
    <div className="profile-fs-overlay" onClick={e => e.stopPropagation()}>
      <button className="pfs-back" onClick={onClose} aria-label="Back to chat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      </button>

      <div className="pfs-cover">
        <div className="pfs-cover-img" /><div className="pfs-cover-bg" />
        <div className="pfs-avatar" onClick={() => { if (avatarUrl) onViewFile(avatarUrl, "avatar-circle"); }}>
          {avatarUrl ? <img src={avatarUrl} alt="Profile" className="img-cover" /> : label?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="pfs-name">{label}</div>
        {c?.username && <div className="pfs-username">@{c.username}</div>}
        <div className={`pfs-status-badge ${c?.is_online ? "online" : "offline"}`}>
          <span className="pfs-dot" />{c?.is_online ? "Online" : "Offline"}
        </div>
      </div>

      <div className="pfs-actions">
        <button className="pfs-action-btn" onClick={() => onCall(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
          <span className="pfs-action-label">Voice</span>
        </button>
        <button className="pfs-action-btn" onClick={() => onCall(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          <span className="pfs-action-label">Video</span>
        </button>
        <button className="pfs-action-btn" onClick={onNicknameEdit}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          <span className="pfs-action-label">Nickname</span>
        </button>
      </div>

      <div className="pfs-tabs">
        {(["info", "media", "calls"] as ProfileTab[]).map(t => (
          <button key={t} className={`pfs-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "info" ? "Info" : t === "media" ? "Media" : "Calls"}
          </button>
        ))}
      </div>

      <div className="pfs-tab-content">
        {tab === "info" && (
          <div className="pfs-info-section">
            {c?.username && (
              <div className="pfs-info-row">
                <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M2 20c0-4 4-7 10-7s10 3 10 7" /></svg></div>
                <div><div className="pfs-info-label">Username</div><div className="pfs-info-val">@{c.username}</div></div>
              </div>
            )}
            <div className="pfs-info-row">
              <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg></div>
              <div><div className="pfs-info-label">Email</div><div className="pfs-info-val">{String(activeChat.id)}</div></div>
            </div>
            <div className="pfs-info-row">
              <div className="pfs-info-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></div>
              <div style={{ flex: 1 }}>
                <div className="pfs-info-label">Nickname</div>
                <div className="pfs-info-val" style={{ color: nicknames[String(activeChat.id)] ? "#fff" : "rgba(255,255,255,0.35)" }}>
                  {nicknames[String(activeChat.id)] || "Not set"}
                </div>
              </div>
              <button className="cp-edit-btn pfs-info-edit" onClick={() => { onClose(); onNicknameEdit(); }}>
                {nicknames[String(activeChat.id)] ? "Edit" : "Add"}
              </button>
            </div>
            <div className="pfs-info-row" style={{ marginTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "1.5rem" }}>
              {isBlocked
                ? <button className="cp-block-btn unblock-btn" onClick={onUnblock} style={{ background: "rgba(76,175,80,0.1)", color: "#4caf50", border: "1px solid rgba(76,175,80,0.2)", padding: "10px 16px", borderRadius: "12px", width: "100%", cursor: "pointer", fontWeight: "bold" }}>Unblock User</button>
                : <button className="cp-block-btn block-btn" onClick={onBlock} style={{ background: "rgba(244,67,54,0.1)", color: "#f44336", border: "1px solid rgba(244,67,54,0.2)", padding: "10px 16px", borderRadius: "12px", width: "100%", cursor: "pointer", fontWeight: "bold" }}>Block User</button>}
            </div>
          </div>
        )}
        {tab === "media" && (
          <div className="pfs-media-section">
            {sharedMedia.length === 0
              ? <div className="pfs-media-empty">📷 No shared media yet</div>
              : <div className="pfs-media-grid">
                {sharedMedia.map((m, i) => (
                  <div key={i} className={`pfs-media-cell ${m.type === "video" ? "pfs-media-cell-vid" : ""}`} onClick={() => onViewFile(m.url, m.type)}>
                    {m.type === "image" ? <img src={m.url} alt="media" /> : <video src={m.url} />}
                  </div>
                ))}
              </div>}
          </div>
        )}
        {tab === "calls" && (
          <div className="pfs-calls-section">
            {myCallLogs.length === 0
              ? <div className="pfs-calls-empty">📞 No calls with this contact</div>
              : myCallLogs.map(log => <CallLogRow key={log.id} log={log} />)}
          </div>
        )}
      </div>
    </div>
  );
}
