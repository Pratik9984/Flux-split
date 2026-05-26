"use client";

import React, { useState, useRef, memo } from "react";
import type { Message, Contact } from "@/app/types";
import { parseTs } from "@/app/utils/helpers";
import { ReactionPickerPortal } from "./ReactionPickerPortal";

// ─── MESSAGE BUBBLE ───────────────────────────────────────────────────────────
interface MessageBubbleProps {
  item: Message & { type: "msg" }; currentUser: string;
  isSelected: boolean; isSelectionModeActive: boolean; isEditing: boolean; editingText: string;
  reactionPickerId: string | number | null; chatType: "user" | "group";
  reactionEmojis: string[]; contacts: Contact[]; isFailed: boolean;
  getPeerName: (email: string) => string; contactLabel: (c: Contact) => string;
  onReply: (msg: Message) => void; onForward: (msg: Message) => void;
  onEditStart: (id: string | number, text: string) => void;
  onEditSave: () => void; onEditCancel: () => void; onEditChange: (text: string) => void;
  onDelete: (id: string | number) => void;
  onReaction: (msgId: string | number, emoji: string) => void;
  onSetReactionPicker: (id: string | number | null) => void;
  onViewFile: (url: string, type: string) => void;
  onSelectMsg: (id: string | number | null) => void;
  onRetry: (msg: Message) => void;
  highlightedMsgId: string | number | null;
}
export const MessageBubble = memo(function MessageBubble({
  item, currentUser, isSelected, isSelectionModeActive, isEditing, editingText, reactionPickerId,
  chatType, reactionEmojis, contacts, isFailed, getPeerName, contactLabel,
  onReply, onForward, onEditStart, onEditSave, onEditCancel, onEditChange,
  onDelete, onReaction, onSetReactionPicker, onViewFile, onSelectMsg, onRetry,
  highlightedMsgId,
}: MessageBubbleProps) {
  const isMine = item.user === currentUser;
  const formatTime = (ts: string) => parseTs(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSwipingRef = useRef(false);
  const replyFired = useRef(false);
  const touchHandledClick = useRef(false);
  const [swipeX, setSwipeX] = useState(0);

  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const t = e.touches[0];
    touchStartX.current = t.clientX;
    touchStartY.current = t.clientY;
    isSwipingRef.current = false;
    replyFired.current = false;
    touchHandledClick.current = false;
    pressTimer.current = setTimeout(() => {
      if (!isSwipingRef.current) {
        touchHandledClick.current = true;
        if (navigator.vibrate) navigator.vibrate(30);
        onSelectMsg(item.id);
        if (!isSelectionModeActive) {
          onSetReactionPicker(reactionPickerId === item.id ? null : item.id);
        }
      }
    }, 450);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      isSwipingRef.current = true;
      clearPress();
      const validSwipe = isMine ? dx < 0 : dx > 0;
      if (validSwipe) {
        const offset = Math.min(Math.abs(dx) * 0.55, 72);
        setSwipeX(offset);
        if (offset >= 55 && !replyFired.current) {
          replyFired.current = true;
          if (navigator.vibrate) navigator.vibrate(30);
          onReply(item);
        }
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigator.vibrate) navigator.vibrate(30);
    onSelectMsg(item.id);
    if (!isSelectionModeActive) {
      onSetReactionPicker(reactionPickerId === item.id ? null : item.id);
    }
  };

  if (item._callRecord) {
    return (
      <div className="msg-row" style={{ justifyContent: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-full)", padding: "5px 14px", fontSize: 11, color: "var(--text-3)", userSelect: "none" }}>
          <span>{item.content}</span><span style={{ opacity: 0.5 }}>· {formatTime(item.timestamp)}</span>
        </div>
      </div>
    );
  }

  if (item.is_deleted) {
    return (
      <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
        <div className="msg-deleted">🚫 Message deleted</div>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
        <div className="edit-row">
          <input
            value={editingText}
            onChange={e => onEditChange(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") onEditSave(); if (e.key === "Escape") onEditCancel(); }}
            className="edit-field"
            autoFocus
          />
          <button onClick={onEditSave} className="edit-save" aria-label="Save edit">✓</button>
          <button onClick={onEditCancel} className="edit-discard" aria-label="Cancel edit">✕</button>
        </div>
      </div>
    );
  }

  const senderLabel = (() => {
    if (chatType !== "group" || isMine) return null;
    const c = contacts.find(c => c.email === item.user);
    return item.sender_name || (c ? contactLabel(c) : "Someone");
  })();
  const senderContact = contacts.find(c => c.email === item.user);
  const showReplyIcon = swipeX > 20;
  const isPickerOpen = reactionPickerId === item.id;
  const isPending = String(item.id).startsWith("temp-") && !isFailed;

  const renderContent = () => {
    const c = item.content;
    if (c.startsWith("[IMAGE]")) return <img src={c.replace("[IMAGE]", "")} alt="attachment" className="msg-img msg-img-media" onClick={() => onViewFile(c.replace("[IMAGE]", ""), "image")} />;
    if (c.startsWith("[AUDIO]")) return <audio src={c.replace("[AUDIO]", "")} controls className="msg-audio msg-audio-media" />;
    if (c.startsWith("[VIDEO]")) return <video src={c.replace("[VIDEO]", "")} controls className="msg-video msg-video-media" onClick={() => onViewFile(c.replace("[VIDEO]", ""), "video")} />;
    if (c.startsWith("[PDF]")) return <iframe src={c.replace("[PDF]", "")} className="msg-pdf msg-pdf-media" title="PDF" />;
    if (c.startsWith("[FILE]")) return <a href={c.replace("[FILE]", "")} target="_blank" rel="noreferrer" className="msg-file-link">📄 Download file</a>;
    if (c.startsWith("[STICKER]")) return <img src={c.replace("[STICKER]", "")} alt="sticker" style={{ width: 120, height: 120, objectFit: "contain", display: "block", borderRadius: 8 }} loading="lazy" />;
    return <span className="msg-text">{c}</span>;
  };

  return (
    <div className={`msg-row ${isMine ? "msg-mine" : "msg-theirs"}`}>
      <div
        className="msg-swipe-wrapper"
        style={{
          transform: swipeX > 0 ? `translateX(${isMine ? -swipeX : swipeX}px)` : undefined,
          transition: swipeX === 0 ? "transform 0.22s var(--ease-spring)" : "none",
        }}
      >
        {!isMine && <div className={`swipe-reply-icon ${showReplyIcon ? "swipe-reply-icon--visible" : ""}`}>↩</div>}

        {!isMine && chatType === "group" && (
          <div className="msg-sender-av">
            {senderContact?.avatar_url
              ? <img src={senderContact.avatar_url} alt="avatar" className="img-cover rounded-circle" />
              : senderLabel?.[0]?.toUpperCase() || "?"}
          </div>
        )}

        <div className={`bw relative-bw ${isSelected ? "bw--selected" : ""}`}>
          {senderLabel && <span className="sender-name">{senderLabel}</span>}

          <div
            ref={bubbleRef}
            className={`bubble ${isMine ? "mine" : "theirs"} ${isFailed ? "bubble--failed" : ""} ${isPending ? "bubble--pending" : ""} ${item.id === highlightedMsgId ? "bubble-highlighted" : ""}`}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={() => { clearPress(); setSwipeX(0); isSwipingRef.current = false; }}
            onClick={e => {
              e.stopPropagation();
              if (isSelectionModeActive) {
                onSelectMsg(item.id);
              }
            }}
            onContextMenu={handleContextMenu}
          >
            {item.is_forwarded && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-3)", marginBottom: 4, fontStyle: "italic", opacity: 0.8 }}>
                <span>↗</span><span>Forwarded</span>
              </div>
            )}

            {item.reply_to_content && (
              <div className="quoted-message">
                <div className="quoted-bar" />
                <div className="quoted-text">{item.reply_to_content}</div>
              </div>
            )}

            {renderContent()}

            <div className="msg-footer">
              <span className="msg-ts">{formatTime(item.timestamp)}</span>
              {item.edited_at && <span className="msg-edited">edited</span>}
              {isMine && (
                <span className={`ticks ${item.is_read ? "ticks--read" : ""}`}>
                  {isFailed ? (
                    <button
                      className="retry-btn"
                      onMouseDown={e => { e.stopPropagation(); onRetry(item); }}
                      onTouchEnd={e => { e.stopPropagation(); onRetry(item); }}
                      aria-label="Retry sending message"
                    >⚠️</button>
                  ) : isPending ? (
                    <span style={{ opacity: 0.5, fontSize: 9 }}>○</span>
                  ) : chatType === "user" ? (
                    item.is_read
                      ? <svg width="14" height="9" viewBox="0 0 22 14" fill="none"><path d="M1 7L6 12L15 1" stroke="currentColor" strokeWidth="2" /><path d="M8 7L13 12L22 1" stroke="currentColor" strokeWidth="2" /></svg>
                      : <svg width="10" height="9" viewBox="0 0 14 14" fill="none"><path d="M1 7L6 12L13 1" stroke="currentColor" strokeWidth="2" /></svg>
                  ) : (item.read_by && item.read_by.length > 0 && (
                    <span className="read-by-tooltip" title={`Read by:\n${item.read_by.map(e => getPeerName(e)).join("\n")}`}>
                      👁 {item.read_by.length}
                    </span>
                  ))}
                </span>
              )}
            </div>

            {item.reactions && Object.keys(item.reactions).length > 0 && (
              <div className="reactions-row">
                {Object.entries(item.reactions).map(([emoji, users]) => (
                  <button
                    key={emoji}
                    className={`reaction-pill ${users.includes(currentUser) ? "user-reacted" : ""}`}
                    onClick={e => { e.stopPropagation(); onReaction(item.id, emoji); }}
                    onMouseDown={e => e.stopPropagation()}
                    onTouchStart={e => e.stopPropagation()}
                    onTouchEnd={e => e.stopPropagation()}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
                    title={users.map(e => getPeerName(e)).join(", ")}
                    aria-label={`Reacted with ${emoji}`}
                  >
                    {emoji}{users.length > 1 && ` ${users.length}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {isMine && (
          <div className={`swipe-reply-icon ${showReplyIcon ? "swipe-reply-icon--visible" : ""}`} style={{ left: "auto", right: "-32px" }}>↩</div>
        )}
      </div>

      {isPickerOpen && (
        <ReactionPickerPortal
          anchorRef={bubbleRef}
          isMine={isMine}
          emojis={reactionEmojis}
          onReact={emoji => { onReaction(item.id, emoji); onSetReactionPicker(null); onSelectMsg(null); }}
          onClose={() => onSetReactionPicker(null)}
        />
      )}
    </div>
  );
});
