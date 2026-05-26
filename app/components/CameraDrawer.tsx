"use client";

import React from "react";

interface CameraDrawerProps {
  showCameraDrawer: boolean;
  setShowCameraDrawer: (val: boolean) => void;
  cameraPhotoInputRef: React.RefObject<HTMLInputElement | null>;
  cameraVideoInputRef: React.RefObject<HTMLInputElement | null>;
}

export function CameraDrawer({
  showCameraDrawer,
  setShowCameraDrawer,
  cameraPhotoInputRef,
  cameraVideoInputRef,
}: CameraDrawerProps) {
  if (!showCameraDrawer) return null;

  return (
    <div className="camera-action-sheet-overlay" onClick={() => setShowCameraDrawer(false)}>
      <div className="camera-action-sheet" onClick={e => e.stopPropagation()}>
        <div className="cas-title">Capture Media</div>
        <div className="cas-options">
          <button
            className="cas-btn"
            onClick={() => {
              setShowCameraDrawer(false);
              cameraPhotoInputRef.current?.click();
            }}
          >
            📸 Take Photo
          </button>
          <button
            className="cas-btn"
            onClick={() => {
              setShowCameraDrawer(false);
              cameraVideoInputRef.current?.click();
            }}
          >
            🎥 Record Video
          </button>
          <button className="cas-btn cas-btn-cancel" onClick={() => setShowCameraDrawer(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
