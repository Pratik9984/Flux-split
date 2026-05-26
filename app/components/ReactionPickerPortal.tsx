"use client";

import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// ─── REACTION PICKER PORTAL ───────────────────────────────────────────────────
interface ReactionPickerPortalProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  isMine: boolean;
  emojis: string[];
  onReact: (emoji: string) => void;
  onClose: () => void;
}
export function ReactionPickerPortal({ anchorRef, isMine, emojis, onReact, onClose }: ReactionPickerPortalProps) {
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", zIndex: 9999, opacity: 0, pointerEvents: "none" });
  const pickerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useLayoutEffect(() => {
    if (!anchorRef.current || !pickerRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const picker = pickerRef.current.getBoundingClientRect();
    const pickerW = picker.width || emojis.length * 44 + 16;
    const pickerH = picker.height || 56;
    let left = isMine ? anchor.right - pickerW : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pickerW - 8));
    let top = anchor.top - pickerH - 8;
    if (top < 8) top = anchor.bottom + 8;
    top = Math.max(8, Math.min(top, window.innerHeight - pickerH - 8));
    setStyle({ position: "fixed", zIndex: 9999, top, left, opacity: 1, pointerEvents: "auto" });
  }, [mounted, isMine, emojis.length]); // eslint-disable-line

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onMouseDown={e => { e.stopPropagation(); onClose(); }}
        onTouchStart={e => { e.stopPropagation(); onClose(); }}
      />
      <div
        ref={pickerRef}
        className="reaction-picker pop"
        style={style}
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchMove={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
      >
        {emojis.map(e => (
          <button
            key={e}
            className="reaction-btn"
            onMouseDown={ev => { ev.stopPropagation(); onReact(e); }}
            onTouchEnd={ev => { ev.stopPropagation(); onReact(e); }}
            aria-label={`React with ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
    </>,
    document.body
  );
}
