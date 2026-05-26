"use client";

import React, { useState, useRef } from "react";

interface MediaViewerProps {
  viewFile: { url: string; type: string } | null;
  onClose: () => void;
  handleDownloadMedia: (url: string) => Promise<void>;
}

export function MediaViewer({ viewFile, onClose, handleDownloadMedia }: MediaViewerProps) {
  const [mediaZoom, setMediaZoom] = useState(1);
  const [mediaPan, setMediaPan] = useState({ x: 0, y: 0 });
  const [isPinching, setIsPinching] = useState(false);
  const initialDistRef = useRef(0);
  const initialZoomRef = useRef(1);
  const initialPanRef = useRef({ x: 0, y: 0 });

  if (!viewFile) return null;

  const handleClose = () => {
    setMediaZoom(1);
    setMediaPan({ x: 0, y: 0 });
    onClose();
  };

  return (
    <div className="file-viewer-overlay" onClick={handleClose}>
      <button className="close-viewer" onClick={handleClose} aria-label="Close media viewer">✕</button>
      {viewFile.type !== "avatar-circle" && (
        <div className="viewer-actions" style={{ position: "absolute", top: 16, right: 60, display: "flex", gap: 12, zIndex: 9999 }} onClick={e => e.stopPropagation()}>
          <button onClick={() => handleDownloadMedia(viewFile.url)} style={{ background: "rgba(0,0,0,0.5)", color: "#fff", padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 14 }}>⬇ Download</button>
        </div>
      )}
      <div
        className="viewer-content"
        onClick={e => e.stopPropagation()}
        style={{ transition: isPinching ? "none" : "transform 0.2s", transform: `translate(${mediaPan.x}px,${mediaPan.y}px) scale(${mediaZoom})` }}
        onTouchStart={e => {
          if (e.touches.length === 2) {
            setIsPinching(true);
            initialDistRef.current = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            initialZoomRef.current = mediaZoom;
          } else if (e.touches.length === 1 && mediaZoom > 1) {
            initialPanRef.current = { x: e.touches[0].clientX - mediaPan.x, y: e.touches[0].clientY - mediaPan.y };
          }
        }}
        onTouchMove={e => {
          if (e.touches.length === 2 && isPinching) {
            const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            setMediaZoom(Math.max(1, Math.min(initialZoomRef.current * (d / initialDistRef.current), 5)));
          } else if (e.touches.length === 1 && mediaZoom > 1) {
            setMediaPan({ x: e.touches[0].clientX - initialPanRef.current.x, y: e.touches[0].clientY - initialPanRef.current.y });
          }
        }}
        onTouchEnd={e => {
          if (e.touches.length < 2) setIsPinching(false);
          if (mediaZoom <= 1) setMediaPan({ x: 0, y: 0 });
        }}
      >
        {viewFile.type === "image" && <img src={viewFile.url} alt="attachment" style={{ pointerEvents: "none" }} />}
        {viewFile.type === "video" && <video src={viewFile.url} controls autoPlay />}
        {viewFile.type === "avatar-circle" && <img src={viewFile.url} alt="Avatar" style={{ pointerEvents: "none", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
      </div>
    </div>
  );
}
