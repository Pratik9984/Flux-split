"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import type { Group, Chat, Contact, CallLogEntry, Message, ProfileTab } from "@/app/types";
import { CallLogRow } from "./CallLogRow";
import { getEmail, getIsAdmin, errorMessage } from "@/app/utils/helpers";

interface GroupProfileProps {
  group: Group | undefined; activeChat: Chat; currentUser: string;
  contacts: Contact[]; contactLabel: (c: Contact) => string;
  callLogs: CallLogEntry[]; messagesCache: Record<string, Message[]>;
  isUploadingGroupAvatar: boolean;
  groupAvatarInputRef: React.RefObject<HTMLInputElement | null>;
  handleGroupAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void; onCall: (video: boolean) => void; onAddMember: (uname: string) => Promise<void>;
  onViewFile: (url: string, type: string) => void;
  getPeerName: (email: string) => string;
  profile: { displayName: string; avatarUrl: string; username: string };
  apiFetch: <T>(path: string, opts?: any) => Promise<T>;
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
  loadGroups: () => Promise<void>;
}

export function GroupProfile({
  group: g, activeChat, currentUser, contacts, contactLabel, callLogs,
  messagesCache, isUploadingGroupAvatar, groupAvatarInputRef, handleGroupAvatarUpload,
  onClose, onCall, onAddMember, onViewFile, profile, apiFetch, setGroups,
  showToast, loadGroups,
}: GroupProfileProps) {
  const [newMemberInput, setNewMemberInput] = useState("");
  const [tab, setTab] = useState<ProfileTab>("members");
  const [memberProfiles, setMemberProfiles] = useState<Record<string, {
    display_name?: string | null; username?: string | null; avatar_url?: string | null;
  }>>({});
  const [openMenuEmail, setOpenMenuEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenuEmail) return;
    const handleClose = () => setOpenMenuEmail(null);
    document.addEventListener("click", handleClose);
    return () => document.removeEventListener("click", handleClose);
  }, [openMenuEmail]);

  useEffect(() => {
    if (!g?.members) return;
    g.members.forEach(async mRaw => {
      const email = getEmail(mRaw);
      if (!email || email === currentUser || contacts.some(c => c.email === email) || memberProfiles[email]) return;
      try {
        const prof = await apiFetch<{ display_name?: string | null; username?: string | null; avatar_url?: string | null }>(`/profile/${encodeURIComponent(email)}`);
        setMemberProfiles(prev => ({ ...prev, [email]: prof }));
      } catch { }
    });
  }, [g, contacts, currentUser, apiFetch]); // eslint-disable-line

  if (!g) return null;
  const myMember = g.members.find(m => getEmail(m) === currentUser);
  const isAdmin = getIsAdmin(myMember) || g.members.length <= 1;

  const sharedMedia = useMemo(() => {
    const msgs = messagesCache[String(activeChat.id)] || [];
    return msgs
      .filter(m => m.content.startsWith("[IMAGE]") || m.content.startsWith("[VIDEO]"))
      .map(m => ({ url: m.content.replace(/^\[IMAGE\]|\[VIDEO\]/, ""), type: m.content.startsWith("[IMAGE]") ? "image" : "video" }));
  }, [messagesCache, activeChat.id]);

  const grpCallLogs = useMemo(() => callLogs.filter(l => l.peer === String(activeChat.id)), [callLogs, activeChat.id]);

  return (
    <div className="profile-fs-overlay" onClick={e => e.stopPropagation()}>
      <button className="pfs-back" onClick={onClose} aria-label="Back to chat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
      </button>

      <div className="pfs-cover">
        <div className="pfs-cover-img" /><div className="pfs-cover-bg" />
        <div className="pfs-avatar" style={{ borderRadius: "var(--r-lg)" }} onClick={() => { if (g.avatar_url) onViewFile(g.avatar_url, "avatar-circle"); }}>
          {g.avatar_url ? <img src={g.avatar_url} alt="Group" className="img-cover" /> : g.name?.[0]?.toUpperCase() || "?"}
        </div>
        {isAdmin && (
          <>
            <input type="file" ref={groupAvatarInputRef} accept="image/*" className="hidden-input" onChange={handleGroupAvatarUpload} />
            <button className="avatar-upload-btn" style={{ zIndex: 2, position: "relative", width: "auto", padding: "4px 14px", marginTop: -4, fontSize: "0.72rem" }} disabled={isUploadingGroupAvatar} onClick={() => groupAvatarInputRef.current?.click()}>
              {isUploadingGroupAvatar ? "Uploading…" : "📷 Change photo"}
            </button>
          </>
        )}
        <div className="pfs-name">{g.name}</div>
        <div className="pfs-username">{g.members.length} members</div>
      </div>

      {/* ── GROUP DESCRIPTION CARD ── */}
      {(() => {
        const desc = (g as any).description || "No description provided.";
        return (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", padding: "14px 16px", margin: "16px 20px 0", textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.05em" }}>Group Description</span>
              {isAdmin && (
                <button
                  onClick={async () => {
                    const nextDesc = window.prompt("Edit Group Description:", (g as any).description || "");
                    if (nextDesc !== null) {
                      try {
                        await apiFetch(`/groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ description: nextDesc }) });
                        g.description = nextDesc;
                        setGroups(prev => prev.map(group => group.id === g.id ? { ...group, description: nextDesc } : group));
                        showToast("Description updated", "success");
                      } catch {
                        showToast("Failed to update description", "error");
                      }
                    }
                  }}
                  className="cp-edit-btn"
                  style={{ fontSize: 11, padding: "3px 8px", minHeight: "auto", minWidth: "auto", width: "auto" }}
                >
                  Edit
                </button>
              )}
            </div>
            <p style={{ fontSize: 13, color: "var(--text-2)", margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
              {desc}
            </p>
          </div>
        );
      })()}

      <div className="pfs-actions">
        <button className="pfs-action-btn" onClick={() => onCall(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
          <span className="pfs-action-label">Voice</span>
        </button>
        <button className="pfs-action-btn" onClick={() => onCall(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          <span className="pfs-action-label">Video</span>
        </button>
      </div>

      <div className="pfs-tabs">
        {(["members", "media", "calls"] as ProfileTab[]).map(t => (
          <button key={t} className={`pfs-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "members" ? "Members" : t === "media" ? "Media" : "Calls"}
          </button>
        ))}
      </div>

      <div className="pfs-tab-content">
        {tab === "members" && (
          <div className="pfs-members-section">
            {g.members.map((mRaw, idx) => {
              const mEmail = getEmail(mRaw);
              const isAdm = getIsAdmin(mRaw);
              const c = contacts.find(contact => contact.email === mEmail);
              const cached = memberProfiles[mEmail];
              const dispName = c ? contactLabel(c) : (mRaw?.display_name || cached?.display_name || (mEmail === currentUser ? profile.displayName : null) || mEmail.split("@")[0]);
              const username = c?.username || mRaw?.username || cached?.username || (mEmail === currentUser ? profile.username : null);
              const avatar = c?.avatar_url || mRaw?.avatar_url || cached?.avatar_url || (mEmail === currentUser ? profile.avatarUrl : null);
              const lbl = dispName || (username ? `@${username}` : mEmail);
              const isCreator = (g as any).created_by === mEmail || mRaw?.role === "creator" || mRaw?.is_creator || idx === 0;
              return (
                <div key={`${mEmail}-${idx}`} className="pfs-member-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div className="pfs-member-av">
                      {avatar ? <img src={avatar} className="img-cover rounded-circle" alt="avatar" /> : lbl?.[0]?.toUpperCase() || "?"}
                    </div>
                    <div>
                      <div className="pfs-member-name">
                        {lbl} {mEmail === currentUser ? " (You)" : ""}
                        {isCreator ? (
                          <span className="admin-badge creator-badge" style={{ background: "rgba(255, 193, 7, 0.15)", color: "#ffc107", marginLeft: 6 }}>Owner</span>
                        ) : isAdm ? (
                          <span className="admin-badge" style={{ marginLeft: 6 }}>Admin</span>
                        ) : null}
                      </div>
                      <div className="pfs-member-sub">{username ? `@${username}` : mEmail}</div>
                    </div>
                  </div>
                  {isAdmin && mEmail !== currentUser && !isCreator && (
                    <div style={{ position: "relative" }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuEmail(openMenuEmail === mEmail ? null : mEmail);
                        }}
                        className="tool-btn"
                        style={{
                          width: 32,
                          height: 32,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "50%",
                          border: "none",
                          background: openMenuEmail === mEmail ? "var(--surface-hover)" : "none",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          fontSize: 16,
                        }}
                        title="Member options"
                        aria-label="Member options"
                      >
                        ⋮
                      </button>
                      {openMenuEmail === mEmail && (
                        <div
                          style={{
                            position: "absolute",
                            top: "calc(100% + 4px)",
                            right: 0,
                            zIndex: 999,
                            background: "var(--surface-1)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--r-md)",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                            minWidth: 140,
                            overflow: "hidden"
                          }}
                          onClick={e => e.stopPropagation()}
                        >
                          <button
                            onClick={async () => {
                              setOpenMenuEmail(null);
                              const action = isAdm ? "demote" : "promote";
                              const confirmMsg = isAdm ? `Demote ${lbl} to Member?` : `Promote ${lbl} to Admin?`;
                              if (!window.confirm(confirmMsg)) return;
                              try {
                                const nextRole = isAdm ? "member" : "admin";
                                await apiFetch(`/groups/${g.id}/members/role`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ member_email: mEmail, role: nextRole })
                                });
                                showToast(`Updated ${lbl}`, "success");
                                mRaw.is_admin = !isAdm;
                                await loadGroups();
                              } catch (err) {
                                showToast("Failed: " + errorMessage(err), "error");
                              }
                            }}
                            className="mute-menu-item"
                            style={{ fontSize: 13, padding: "10px 14px" }}
                          >
                            🛡 {isAdm ? "Demote" : "Make Admin"}
                          </button>
                          <button
                            onClick={async () => {
                              setOpenMenuEmail(null);
                              if (!window.confirm(`Remove ${lbl} from group?`)) return;
                              try {
                                await apiFetch(`/groups/${g.id}/members?member_email=${encodeURIComponent(mEmail)}`, { method: "DELETE" });
                                showToast(`${lbl} removed`, "success");
                                await loadGroups();
                              } catch (err) {
                                showToast("Failed to remove member", "error");
                              }
                            }}
                            className="mute-menu-item"
                            style={{ fontSize: 13, padding: "10px 14px", color: "#ef4444" }}
                          >
                            🗑 Remove
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {isAdmin && (
              <div className="pfs-add-member">
                <input
                  value={newMemberInput}
                  onChange={e => setNewMemberInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && newMemberInput.trim()) {
                      onAddMember(newMemberInput.trim());
                      setNewMemberInput("");
                    }
                  }}
                  placeholder="Add by @username or email"
                  className="sb-field m-0 flex-grow"
                />
                <button className="cp-edit-btn ms-2" onClick={() => {
                  if (newMemberInput.trim()) {
                    onAddMember(newMemberInput.trim());
                    setNewMemberInput("");
                  }
                }}>Add</button>
              </div>
            )}
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
            {grpCallLogs.length === 0
              ? <div className="pfs-calls-empty">📞 No group calls yet</div>
              : grpCallLogs.map(log => <CallLogRow key={log.id} log={log} />)}
          </div>
        )}
      </div>

      <div style={{ padding: "0 20px 24px", marginTop: "auto" }}>
        <button
          onClick={async () => {
            if (!window.confirm("Are you sure you want to permanently leave this group?")) return;
            try {
              await apiFetch(`/groups/${g.id}/members?member_email=${encodeURIComponent(currentUser)}`, { method: "DELETE" });
              showToast("You have left the group", "success");
              onClose();
              await loadGroups();
            } catch (err) {
              showToast("Failed to leave group: " + errorMessage(err), "error");
            }
          }}
          className="cp-block-btn block-btn"
          style={{
            background: "rgba(244,67,54,0.1)",
            color: "#f44336",
            border: "1px solid rgba(244,67,54,0.2)",
            padding: "12px 16px",
            borderRadius: "12px",
            width: "100%",
            cursor: "pointer",
            fontWeight: "bold",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            transition: "all 0.2s ease"
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          Leave Group
        </button>
      </div>
    </div>
  );
}
