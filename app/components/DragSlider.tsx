"use client";

import React, { useState, useRef } from "react";

interface DragSliderProps {
  label: string;
  type: "accept" | "decline";
  onTrigger: () => void;
}

export function DragSlider({ label, type, onTrigger }: DragSliderProps) {
  const [posX, setPosX] = useState(0);
  const handleRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    startX.current = e.clientX;
    if (handleRef.current) {
      handleRef.current.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const deltaX = e.clientX - startX.current;
    const newX = Math.max(0, Math.min(120, deltaX));
    setPosX(newX);

    if (newX >= 120) {
      isDragging.current = false;
      onTrigger();
    }
  };

  const onPointerUp = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setPosX(0);
  };

  return (
    <div className={`slide-track slide-track-${type}`}>
      <span className="slide-track-text">{label}</span>
      <div
        ref={handleRef}
        className={`slide-handle slide-handle-${type}`}
        style={{ transform: `translateX(${posX}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {type === "accept" ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        )}
      </div>
    </div>
  );
}
