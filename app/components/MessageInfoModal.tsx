"use client";

import React from "react";
import type { Message, Group, Contact } from "@/app/types";
import { getEmail, parseTs } from "@/app/utils/helpers";

interface MessageInfoModalProps {
  message: Message; group: Group | undefined;
  contacts: Contact[]; currentUser: string;
  getPeerName: (email: string) => string; onClose: () => void;
}

export function MessageInfoModal({ message, group, contacts, getPeerName, onClose }: MessageInfoModalProps) {
  if (!group) return null;

  const readBy = message.read_by || [];
  const otherMembers = group.members.filter(m => getEmail(m) !== message.user);
  const viewedMembers = otherMembers.filter(m => readBy.includes(getEmail(m)));
  const remainingMembers = otherMembers.filter(m => !readBy.includes(getEmail(m)));

  const getMemberName = (mRaw: any) => {
    const email = getEmail(mRaw);
    const c = contacts.find(contact => contact.email === email);
    return c ? (c.display_name || c.username || email) : (mRaw?.display_name || mRaw?.username || email.split("@")[0]);
  };
  const getMemberSub = (mRaw: any) => {
    const email = getEmail(mRaw);
    const c = contacts.find(contact => contact.email === email);
    return c?.username ? `@${c.username}` : (mRaw?.username ? `@${mRaw.username}` : email);
  };
  const getMemberAvatar = (mRaw: any) => {
    const email = getEmail(mRaw);
    const c = contacts.find(contact => contact.email === email);
    return c?.avatar_url || mRaw?.avatar_url || null;
  };

  const MemberRow = ({ mRaw, idx }: { mRaw: any; idx: number }) => {
    const name = getMemberName(mRaw);
    const sub = getMemberSub(mRaw);
    const avatar = getMemberAvatar(mRaw);
    return (
      <div key={idx} className="pfs-member-item" style={{ padding: "8px 0" }}>
        <div className="pfs-member-av">{avatar ? <img src={avatar} className="img-cover rounded-circle" alt="avatar" /> : name[0]?.toUpperCase() || "?"}</div>
        <div>
          <div className="pfs-member-name" style={{ fontSize: "0.9rem" }}>{name}</div>
          <div className="pfs-member-sub" style={{ fontSize: "0.75rem" }}>{sub}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="profile-fs-overlay" onClick={e => e.stopPropagation()} style={{ zIndex: 300 }}>
      <button className="pfs-back" onClick={onClose} aria-label="Close message info">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      </button>
      <div className="pfs-cover" style={{ minHeight: "180px", paddingBottom: "16px" }}>
        <div className="pfs-cover-img" /><div className="pfs-cover-bg" />
        <div className="pfs-name" style={{ fontSize: "1.2rem", marginTop: "32px" }}>Message Info</div>
        <div className="pfs-username" style={{ maxWidth: "80%", margin: "0 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.8 }}>
          "{message.content.startsWith("[") ? "📎 Attachment" : message.content}"
        </div>
        <div className="pfs-username" style={{ opacity: 0.5, fontSize: "0.75rem", marginTop: 4 }}>
          Sent at {parseTs(message.timestamp).toLocaleString()}
        </div>
      </div>
      <div className="pfs-tab-content" style={{ flex: 1, padding: "16px", overflowY: "auto" }}>
        <div style={{ color: "var(--green)", fontWeight: 700, fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "12px", display: "flex", justifyContent: "space-between" }}>
          <span>👁 Viewed By</span>
          <span style={{ background: "rgba(37,211,102,0.15)", color: "#4fe081", padding: "2px 8px", borderRadius: "10px", fontSize: "0.75rem" }}>{viewedMembers.length}</span>
        </div>
        {viewedMembers.length === 0
          ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem", fontStyle: "italic", marginBottom: "24px", paddingLeft: "8px" }}>No one has viewed this message yet.</div>
          : <div className="pfs-members-section" style={{ marginBottom: "24px" }}>{viewedMembers.map((m, i) => <MemberRow key={i} mRaw={m} idx={i} />)}</div>}

        <div style={{ color: "var(--text-2)", fontWeight: 700, fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "12px", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "16px", display: "flex", justifyContent: "space-between" }}>
          <span>📥 Delivered (Remaining)</span>
          <span style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-2)", padding: "2px 8px", borderRadius: "10px", fontSize: "0.75rem" }}>{remainingMembers.length}</span>
        </div>
        {remainingMembers.length === 0
          ? <div style={{ color: "var(--text-3)", fontSize: "0.85rem", fontStyle: "italic", paddingLeft: "8px" }}>All members have read this message.</div>
          : <div className="pfs-members-section">{remainingMembers.map((m, i) => <MemberRow key={i} mRaw={m} idx={i} />)}</div>}
      </div>
    </div>
  );
}
