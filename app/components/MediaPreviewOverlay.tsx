"use client";

import React from "react";

interface PendingFile {
  file: File;
  url: string;
  type: "image" | "audio" | "video" | "pdf" | "file";
  caption?: string;
}

interface MediaPreviewOverlayProps {
  pendingFiles: PendingFile[];
  setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
  inputMsg: string;
  setInputMsg: (val: string) => void;
  multiUploadProgress: { current: number; total: number } | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  sendMessage: () => void;
}

export function MediaPreviewOverlay({
  pendingFiles,
  setPendingFiles,
  inputMsg,
  setInputMsg,
  multiUploadProgress,
  fileInputRef,
  sendMessage,
}: MediaPreviewOverlayProps) {
  if (pendingFiles.length === 0) return null;

  return (
    <div className="media-previews-overlay">
      <div className="mp-header">
        <h2 className="mp-title">Share Media ({pendingFiles.length})</h2>
        <button className="mp-close" onClick={() => setPendingFiles([])} aria-label="Cancel sharing">✕</button>
      </div>
      <div className="mp-carousel">
        <div className="mp-scroll-track">
          {pendingFiles.map((item, idx) => (
            <div key={idx} className="mp-card">
              <button
                className="mp-card-delete"
                onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== idx))}
                aria-label="Remove file"
              >
                ✕
              </button>
              {item.type === "image" && <img src={item.url} alt="preview" />}
              {item.type === "video" && <video src={item.url} muted playsInline />}
              {item.type !== "image" && item.type !== "video" && (
                <div className="mp-card-doc">
                  <span style={{ fontSize: 36 }}>📄</span>
                  <span className="mp-card-doc-name">{item.file.name}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mp-footer">
        <div className="mp-caption-wrapper">
          <input
            type="text"
            placeholder="Add a caption..."
            value={inputMsg}
            onChange={e => setInputMsg(e.target.value)}
            className="mp-caption-input"
          />
        </div>
        <div className="mp-controls-row">
          <button className="mp-add-more-btn" onClick={() => fileInputRef.current?.click()}>
            <span>➕</span> Add more files
          </button>
          {multiUploadProgress ? (
            <div className="mp-progress-indicator">
              <span className="spinner" style={{ width: 16, height: 16 }} />
              <span>Sending {multiUploadProgress.current} of {multiUploadProgress.total}…</span>
            </div>
          ) : (
            <button className="mp-send-btn" onClick={sendMessage}>
              <span>Send</span> ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
