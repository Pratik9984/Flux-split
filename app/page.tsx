"use client";

import React, {
  useState, useEffect, useRef, useMemo, useCallback,
  useReducer, useLayoutEffect, memo,
} from "react";
import "./globals.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { requestNotificationPermission as requestFCMPermission } from "@/lib/firebase";
import {
  getOrCreateIdentityKeyPair, encryptDM, decryptDM,
  generateGroupKey, wrapGroupKeyForMember, unwrapGroupKey,
  encryptGroupMsg, decryptGroupMsg, isDMEncrypted, isGroupEncrypted, groupKeyCache,
} from "@/lib/crypto";
import { initOTAUpdater } from "@/lib/updater";

import { Capacitor } from "@capacitor/core";
import {
  preloadSounds, playNotification, playRingtone, stopRingtoneNative,
} from "@/lib/capacitorAudio";
import {
  requestNotifyPermission, showLocalNotification, showCallNotification, cancelCallNotification,
} from "@/lib/capacitorNotify";
import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Filesystem, Directory } from "@capacitor/filesystem";

// Extracted types
import type {
  StickerPackMeta, StickerItem, Chat, Contact, Group, Message,
  GroupedMessage, CallState, ApiOptions, AuthStep, CallLogEntry,
  WsStatus, ProfileTab, StoredCallOffer, AuthState, AuthAction
} from "@/app/types";

// Extracted constants and helpers
import { supabase, IS_NATIVE, FluxNative, API, WS_URL, USERNAME_RE } from "@/app/utils/constants";
import {
  errorMessage, getEmail, getIsAdmin, safeParseJSON,
  fmtDuration, parseTs, formatTimeAgo, updateReactionsForUser
} from "@/app/utils/helpers";
import { idbSet } from "@/app/utils/idb";
import { authInit, authReducer } from "@/app/utils/authReducer";

// Extracted hooks
import { useDebounce, useDebounceCallback } from "@/app/hooks/useDebounce";
import { useDebouncedLocalStorage } from "@/app/hooks/useDebouncedLocalStorage";

// Extracted components
import { ReactionPickerPortal } from "@/app/components/ReactionPickerPortal";
import { ContactItem } from "@/app/components/ContactItem";
import { GroupItem } from "@/app/components/GroupItem";
import { MessageBubble } from "@/app/components/MessageBubble";
import { CallLogRow } from "@/app/components/CallLogRow";
import { ContactProfile } from "@/app/components/ContactProfile";
import { GroupProfile } from "@/app/components/GroupProfile";
import { DragSlider } from "@/app/components/DragSlider";
import { MessageInfoModal } from "@/app/components/MessageInfoModal";
import { AuthScreen } from "@/app/components/AuthScreen";
import { Toast } from "@/app/components/Toast";
import { MediaViewer } from "@/app/components/MediaViewer";
import { ForwardPicker } from "@/app/components/ForwardPicker";
import { MediaPreviewOverlay } from "@/app/components/MediaPreviewOverlay";
import { CameraDrawer } from "@/app/components/CameraDrawer";


// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function FluxChat() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    if (IS_NATIVE) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js")
      .then(() => { idbSet("api_url", API); })
      .catch(() => { });
  }, []);

  const [auth, dispatchAuth] = useReducer(authReducer, authInit);
  const pendingSupabaseToken = useRef("");
  const [token, setToken] = useState("");
  const [blockedUsers, setBlockedUsers] = useState<Set<string>>(new Set());
  const [showBlockedList, setShowBlockedList] = useState(false);
  const [currentUser, setCurrentUser] = useState("");
  const [profile, setProfile] = useState({ displayName: "", avatarUrl: "", username: "" });
  const isAuth = !!token;

  const tokenRef = useRef(token);
  const currentUserRef = useRef(currentUser);
  const blockedUsersRef = useRef(blockedUsers);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
  useEffect(() => { blockedUsersRef.current = blockedUsers; }, [blockedUsers]);

  const e2ePrivKeyRef = useRef<CryptoKey | null>(null);
  const e2ePubKeyB64Ref = useRef<string>("");
  const pubKeyCache = useRef<Map<string, string>>(new Map());
  const abortControllerRef = useRef<AbortController>(new AbortController());

  useEffect(() => { if (typeof document !== "undefined") document.body.classList.toggle("auth-mode", !isAuth); }, [isAuth]);

  const apiFetch = useCallback(async <T,>(path: string, opts: ApiOptions = {}): Promise<T> => {
    const headers = new Headers(opts.headers as HeadersInit | undefined);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("ngrok-skip-browser-warning", "true");
    if (tokenRef.current) headers.set("Authorization", `Bearer ${tokenRef.current}`);
    const signal = opts.signal ?? (
      abortControllerRef.current.signal.aborted
        ? (abortControllerRef.current = new AbortController()).signal
        : abortControllerRef.current.signal
    );
    const res = await fetch(`${API}${path}`, { ...opts, headers, signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: "Request failed" }));
      throw new Error(body.detail || "Request failed");
    }
    return res.json();
  }, []);

  // ── BLOCK/UNBLOCK ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    apiFetch<{ email: string }[]>("/blocks")
      .then(list => setBlockedUsers(new Set(list.map(b => b.email))))
      .catch(() => { });
  }, [token, apiFetch]);

  const blockUser = async (targetEmail: string) => {
    if (!window.confirm(`Block ${targetEmail}? They won't be able to message or call you.`)) return;
    try {
      await apiFetch(`/blocks/${encodeURIComponent(targetEmail)}`, { method: "POST" });
      setBlockedUsers(prev => new Set([...prev, targetEmail]));
      setContacts(prev => prev.filter(c => c.email !== targetEmail));
      if (activeChat?.id === targetEmail) { setActiveChat(null); setMessages([]); }
      showToast("User blocked", "success");
      setShowContactProfile(false);
    } catch (err) { showToast("Failed to block: " + errorMessage(err), "error"); }
  };

  const unblockUser = async (targetEmail: string) => {
    try {
      await apiFetch(`/blocks/${encodeURIComponent(targetEmail)}`, { method: "DELETE" });
      setBlockedUsers(prev => { const n = new Set(prev); n.delete(targetEmail); return n; });
      showToast("User unblocked", "success");
    } catch (err) { showToast("Failed to unblock: " + errorMessage(err), "error"); }
  };

  // ── MUTE ─────────────────────────────────────────────────────────────────────
  const muteChat = async (chatId: string, chatType: "user" | "group", duration: "8h" | "1w" | "forever") => {
    try {
      const res = await apiFetch<{ muted_until: string | null }>(
        `/mute/${chatType}/${encodeURIComponent(chatId)}`,
        { method: "POST", body: JSON.stringify({ duration }) },
      );
      setMutedChats(prev => ({ ...prev, [chatId]: res.muted_until ? new Date(res.muted_until).getTime() : null }));
      const label = duration === "8h" ? "8 hours" : duration === "1w" ? "1 week" : "forever";
      showToast(`Muted for ${label}`, "success");
    } catch (err) { showToast("Failed to mute: " + errorMessage(err), "error"); }
    setShowMuteMenu(false);
  };

  const unmuteChat = async (chatId: string, chatType: "user" | "group") => {
    try {
      await apiFetch(`/mute/${chatType}/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      setMutedChats(prev => { const n = { ...prev }; delete n[chatId]; return n; });
      showToast("Notifications unmuted", "success");
    } catch (err) { showToast("Failed to unmute: " + errorMessage(err), "error"); }
    setShowMuteMenu(false);
  };

  // ── SUPABASE PASSWORD RECOVERY ───────────────────────────────────────────────
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(event => {
      if (event === "PASSWORD_RECOVERY") dispatchAuth({ type: "SET_STEP", step: "reset-password" });
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── STATE ─────────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Contact[]>(() => safeParseJSON<Contact[]>(typeof window !== "undefined" ? localStorage.getItem("cached_contacts") : null, []));
  const [groups, setGroups] = useState<Group[]>(() => safeParseJSON<Group[]>(typeof window !== "undefined" ? localStorage.getItem("cached_groups") : null, []));
  useDebouncedLocalStorage(contacts.length > 0 ? "cached_contacts" : "", contacts);
  useDebouncedLocalStorage(groups.length > 0 ? "cached_groups" : "", groups);

  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>(() => typeof window === "undefined" ? {} : safeParseJSON<Record<string, number>>(localStorage.getItem("cached_unread"), {}));
  const [lastActivity, setLastActivity] = useState<Record<string, number>>({});
  const [lastPreview, setLastPreview] = useState<Record<string, string>>({});
  const totalUnread = useMemo(() => Object.values(unread).reduce((sum, n) => sum + (n || 0), 0), [unread]);
  useDebouncedLocalStorage(token ? "cached_unread" : "", unread, 1000);

  const [failedMsgIds, setFailedMsgIds] = useState<Set<string>>(new Set());
  const pendingTempTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastReplacedTempRef = useRef<string | null>(null);
  const [deletedMsgIds, setDeletedMsgIds] = useState<Set<string>>(new Set<string>());
  const deletedMsgIdsRef = useRef<Set<string>>(new Set<string>());
  useEffect(() => { deletedMsgIdsRef.current = deletedMsgIds; }, [deletedMsgIds]);

  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "info") => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => { setToast(null); toastTimeoutRef.current = null; }, 3000);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const saved = localStorage.getItem(`deleted_msgs_${currentUser}`);
    const ids = saved ? new Set<string>(safeParseJSON<string[]>(saved, [])) : new Set<string>();
    setDeletedMsgIds(ids);
    deletedMsgIdsRef.current = ids;
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    try {
      const saved = localStorage.getItem(`pinned_msgs_${currentUser}`);
      if (saved) setPinnedMessages(JSON.parse(saved));
    } catch { }
  }, [currentUser]);

  const savePinnedMessages = (next: Record<string, Message[]>) => {
    setPinnedMessages(next);
    if (currentUser) {
      try {
        localStorage.setItem(`pinned_msgs_${currentUser}`, JSON.stringify(next));
      } catch { }
    }
  };

  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [typingSet, setTypingSet] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null);
  const [forwardingMsgs, setForwardingMsgs] = useState<Message[]>([]);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [reactionPickerId, setReactionPickerId] = useState<string | number | null>(null);
  const [selectedMsgId, setSelectedMsgId] = useState<string | number | null>(null);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string | number>>(new Set());

  const toggleSelectMsg = useCallback((id: string | number | null) => {
    if (id === null) {
      setSelectedMsgIds(new Set());
      setSelectedMsgId(null);
      return;
    }
    setSelectedMsgIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      if (next.size === 1) {
        setSelectedMsgId(Array.from(next)[0]);
      } else {
        setSelectedMsgId(null);
      }
      return next;
    });
  }, []);
  const [messageInfoMsg, setMessageInfoMsg] = useState<Message | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [emojiPanelTab, setEmojiPanelTab] = useState<"emojis" | "stickers">("emojis");

  const showEmojis = showEmojiPanel && emojiPanelTab === "emojis";
  const showStickers = showEmojiPanel && emojiPanelTab === "stickers";

  const setShowEmojis = (val: boolean | ((prev: boolean) => boolean)) => {
    if (typeof val === "function") {
      setShowEmojiPanel(prev => { const next = val(prev && emojiPanelTab === "emojis"); if (next) setEmojiPanelTab("emojis"); return next; });
    } else { setShowEmojiPanel(val); if (val) setEmojiPanelTab("emojis"); }
  };
  const setShowStickers = (val: boolean | ((prev: boolean) => boolean)) => {
    if (typeof val === "function") {
      setShowEmojiPanel(prev => { const next = val(prev && emojiPanelTab === "stickers"); if (next) setEmojiPanelTab("stickers"); return next; });
    } else { setShowEmojiPanel(val); if (val) setEmojiPanelTab("stickers"); }
  };

  const [stickerPacks, setStickerPacks] = useState<StickerPackMeta[]>([]);
  const [activeStickerPack, setActiveStickerPack] = useState<number | null>(null);
  const [packStickers, setPackStickers] = useState<Record<number, StickerItem[]>>({});
  const [loadingStickers, setLoadingStickers] = useState(false);
  const [focusedEmojiCoord, setFocusedEmojiCoord] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const emojiActiveCellRef = useRef<HTMLButtonElement | null>(null);
  const emojiToggleRef = useRef<HTMLButtonElement | null>(null);

  const [showProfile, setShowProfile] = useState(false);
  const [showMyProfileSettings, setShowMyProfileSettings] = useState(false);
  const [mutedChats, setMutedChats] = useState<Record<string, number | null>>({});
  const [showMuteMenu, setShowMuteMenu] = useState(false);

  // ── RINGTONE STATE ────────────────────────────────────────────────────────────
  const [ringtonePref, setRingtonePref] = useState("ringtone");
  const [systemRingtones, setSystemRingtones] = useState<{ name: string; uri: string }[]>([]);
  const [customRingtoneName, setCustomRingtoneName] = useState<string | null>(null);
  const [showRingtonePicker, setShowRingtonePicker] = useState(false);
  const [previewActive, setPreviewActive] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("Flux_ringtone_name");
      if (saved) setRingtonePref(saved);
      const name = localStorage.getItem("Flux_custom_ringtone_name");
      if (name) setCustomRingtoneName(name);
    } catch { }
  }, []);

  useEffect(() => {
    if (!showMyProfileSettings || !IS_NATIVE || !FluxNative || !(FluxNative as any).getSystemRingtones) return;
    (FluxNative as any).getSystemRingtones()
      .then((res: any) => { if (res?.ringtones) setSystemRingtones(res.ringtones); })
      .catch(() => { });
  }, [showMyProfileSettings]);

  const stopPreview = useCallback(() => {
    if (previewTimeoutRef.current) { clearTimeout(previewTimeoutRef.current); previewTimeoutRef.current = null; }
    setPreviewActive(null);
    if (IS_NATIVE) {
      try { stopRingtoneNative(); } catch { }
      if (FluxNative) (FluxNative as any).setRingtone({ ringtone: ringtonePref }).catch(() => { });
    } else {
      if (previewAudioRef.current) {
        try { previewAudioRef.current.pause(); previewAudioRef.current.currentTime = 0; } catch { }
        previewAudioRef.current = null;
      }
    }
  }, [ringtonePref]);

  const startPreview = useCallback((value: string) => {
    stopPreview();
    setPreviewActive(value);
    if (IS_NATIVE && FluxNative) {
      (FluxNative as any).setRingtone({ ringtone: value }).then(() => { try { playRingtone(); } catch { } }).catch(() => { });
      previewTimeoutRef.current = setTimeout(stopPreview, 5000);
    } else {
      let src = value === "ringtone" ? "/ringtone.mp3"
        : value === "ringtone2" ? "/ringtone2.mp3"
          : value === "ringtone3" ? "/ringtone3.mp3"
            : value === "custom_file" ? (localStorage.getItem("Flux_custom_ringtone_data") || "") : "";
      if (!src) { stopPreview(); return; }
      const audio = new Audio(src);
      audio.volume = 1.0;
      audio.play().then(() => {
        previewAudioRef.current = audio;
        previewTimeoutRef.current = setTimeout(stopPreview, 5000);
      }).catch(stopPreview);
    }
  }, [stopPreview]);

  const togglePreview = useCallback((e: React.MouseEvent, value: string) => {
    e.stopPropagation();
    previewActive === value ? stopPreview() : startPreview(value);
  }, [previewActive, startPreview, stopPreview]);

  useEffect(() => { if (!showMyProfileSettings) stopPreview(); }, [showMyProfileSettings, stopPreview]);

  const handleRingtoneChange = (name: string) => {
    setRingtonePref(name);
    try { localStorage.setItem("Flux_ringtone_name", name); } catch { }
    if (IS_NATIVE && FluxNative) {
      (FluxNative as any).setRingtone({ ringtone: name }).catch(() => { });
    } else if (ringtoneRef.current) {
      const src = name === "ringtone2" ? "/ringtone2.mp3"
        : name === "ringtone3" ? "/ringtone3.mp3"
          : name === "custom_file" ? (localStorage.getItem("Flux_custom_ringtone_data") || "/ringtone.mp3")
            : "/ringtone.mp3";
      try { ringtoneRef.current.src = src; ringtoneRef.current.load(); } catch { }
    }
  };

  const handleCustomRingtoneUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert("Please select an audio file under 5 MB."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      try {
        localStorage.setItem("Flux_custom_ringtone_data", base64);
        localStorage.setItem("Flux_custom_ringtone_name", file.name);
        setCustomRingtoneName(file.name);
        handleRingtoneChange("custom_file");
      } catch { alert("Failed to save custom ringtone. Storage quota might be exceeded."); }
    };
    reader.readAsDataURL(file);
  };

  // ── MORE STATE ────────────────────────────────────────────────────────────────
  const [showCallLogUI, setShowCallLogUI] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showNewContact, setShowNewContact] = useState(false);
  const [newContactUsername, setNewContactUsername] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupMemberChips, setNewGroupMemberChips] = useState<string[]>([]);
  const [newGroupMemberInput, setNewGroupMemberInput] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [showGroupProfile, setShowGroupProfile] = useState(false);
  const [showContactProfile, setShowContactProfile] = useState(false);
  const [openedProfileFromSidebar, setOpenedProfileFromSidebar] = useState(false);
  const [isUploadingGroupAvatar, setIsUploadingGroupAvatar] = useState(false);
  const groupAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const cameraPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const cameraVideoInputRef = useRef<HTMLInputElement | null>(null);
  const [sidebarDeleteId, setSidebarDeleteId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelRecordingRef = useRef(false);
  const [pendingFile, setPendingFile] = useState<{ file: File; url: string; type: "image" | "audio" | "video" | "pdf" | "file" } | null>(null);
  const [pinnedMessages, setPinnedMessages] = useState<Record<string, Message[]>>({});
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | number | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; url: string; type: "image" | "audio" | "video" | "pdf" | "file"; caption?: string }[]>([]);
  const [multiUploadProgress, setMultiUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [showCameraDrawer, setShowCameraDrawer] = useState(false);
  const [forwardSelectedTargets, setForwardSelectedTargets] = useState<{ type: "user" | "group"; id: string | number; name: string }[]>([]);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);

  // ── CALL STATE ────────────────────────────────────────────────────────────────
  const [callState, setCallState] = useState<CallState>("idle");
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [callPeer, setCallPeer] = useState<string | null>(null);
  const [callPeerName, setCallPeerName] = useState<string>("");
  const [viewFile, setViewFile] = useState<{ url: string; type: string } | null>(null);
  const [callLogs, setCallLogs] = useState<CallLogEntry[]>(() => typeof window !== "undefined" ? safeParseJSON<CallLogEntry[]>(localStorage.getItem("cached_call_logs"), []) : []);
  const [showHeaderNicknameEdit, setShowHeaderNicknameEdit] = useState(false);
  const [headerNicknameValue, setHeaderNicknameValue] = useState("");
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [remoteVideoMuted, setRemoteVideoMuted] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [cameraStates, setCameraStates] = useState<Record<string, boolean>>({});
  const [pipPos, setPipPos] = useState({ x: 16, y: 100 });
  const [isVideoSwapped, setIsVideoSwapped] = useState(false);
  const pipDragging = useRef(false);
  const pipDragStart = useRef({ mx: 0, my: 0, x: 0, y: 0 });

  // ── AUDIO REFS ────────────────────────────────────────────────────────────────
  const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const ringtonePlayPromise = useRef<Promise<void> | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringtoneActiveRef = useRef(false);

  // ── AUDIO INIT ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (IS_NATIVE) {
      preloadSounds();
      remoteAudioRef.current = Object.assign(new Audio(), { autoplay: true, volume: 1.0 });
    } else {
      notificationSoundRef.current = Object.assign(new Audio("/notification.mp3"), { volume: 0.7, preload: "auto" });
      let src = "/ringtone.mp3";
      try {
        const pref = localStorage.getItem("Flux_ringtone_name");
        if (pref === "custom_file") src = localStorage.getItem("Flux_custom_ringtone_data") || src;
        else if (pref === "ringtone2") src = "/ringtone2.mp3";
        else if (pref === "ringtone3") src = "/ringtone3.mp3";
      } catch { }
      ringtoneRef.current = Object.assign(new Audio(src), { loop: true, volume: 1.0, preload: "auto" });
      ringtoneRef.current.load();
      notificationSoundRef.current.load();
      remoteAudioRef.current = Object.assign(new Audio(), { autoplay: true, volume: 1.0 });
    }
  }, []);

  useEffect(() => {
    if (IS_NATIVE) return;
    const unlock = () => {
      [notificationSoundRef.current, ringtoneRef.current].forEach(audio => {
        if (!audio) return;
        audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => { });
      });
    };
    const events = ["touchstart", "touchend", "mousedown", "keydown", "click"];
    events.forEach(e => document.addEventListener(e, unlock, { once: true, passive: true }));
    return () => events.forEach(e => document.removeEventListener(e, unlock));
  }, []);

  const playNotificationSound = useCallback(() => {
    if (IS_NATIVE) { playNotification(); return; }
    const audio = notificationSoundRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => { });
  }, []);

  const startRingtone = useCallback(() => {
    if (ringtoneRetryRef.current) { clearTimeout(ringtoneRetryRef.current); ringtoneRetryRef.current = null; }
    ringtoneActiveRef.current = true;
    if (IS_NATIVE) {
      try { playRingtone(); } catch { }
      ringtoneRetryRef.current = setTimeout(() => { if (ringtoneActiveRef.current) { try { playRingtone(); } catch { } } }, 400);
      return;
    }
    const audio = ringtoneRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    const attempt = (retriesLeft: number) => {
      if (!ringtoneActiveRef.current) return;
      const p = audio.play();
      ringtonePlayPromise.current = p;
      p.catch(() => { if (ringtoneActiveRef.current && retriesLeft > 0) ringtoneRetryRef.current = setTimeout(() => attempt(retriesLeft - 1), 600); });
    };
    attempt(3);
  }, []);

  const stopRingtone = useCallback(() => {
    ringtoneActiveRef.current = false;
    if (ringtoneRetryRef.current) { clearTimeout(ringtoneRetryRef.current); ringtoneRetryRef.current = null; }
    if (IS_NATIVE) { try { stopRingtoneNative(); } catch { } return; }
    const audio = ringtoneRef.current;
    if (!audio) return;
    const pending = ringtonePlayPromise.current;
    ringtonePlayPromise.current = null;
    const doStop = () => { try { audio.pause(); audio.currentTime = 0; } catch { } };
    if (pending) pending.then(doStop).catch(doStop);
    else doStop();
  }, []);

  // ── PERSIST STATE ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    try { const saved = localStorage.getItem(`nicknames_${currentUser}`); setNicknames(saved ? JSON.parse(saved) : {}); } catch { setNicknames({}); }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    const savedActivity = localStorage.getItem(`last_activity_${currentUser}`);
    if (savedActivity) try { setLastActivity(JSON.parse(savedActivity)); } catch { }
    const savedPreview = localStorage.getItem(`last_preview_${currentUser}`);
    if (savedPreview) try { setLastPreview(JSON.parse(savedPreview)); } catch { }
  }, [currentUser]);

  // ── REFS ──────────────────────────────────────────────────────────────────────
  const msgListRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsRetryDelay = useRef(800);
  const wsRetryCount = useRef(0);
  const wsPingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPongRef = useRef(Date.now());
  const pendingMessages = useRef<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingRemoteDescriptionRef = useRef<RTCSessionDescriptionInit | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [messagesCache, setMessagesCache] = useState<Record<string, Message[]>>({});
  const messagesCacheRef = useRef<Record<string, Message[]>>({});
  useEffect(() => { messagesCacheRef.current = messagesCache; }, [messagesCache]);
  const rowVirtualizerRef = useRef<any>(null);
  const groupedMessagesRef = useRef<any[]>([]);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const iceQueuesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const pendingMeshOffersRef = useRef<Map<string, RTCSessionDescriptionInit>>(new Map());
  const callStateRef = useRef<CallState>("idle");
  const callStartTimeRef = useRef<number | null>(null);
  const callDirectionRef = useRef<"incoming" | "outgoing" | null>(null);
  const acceptInProgressRef = useRef(false);
  const activeChatRef = useRef<Chat | null>(activeChat);
  const contactsRef = useRef(contacts);
  const groupsRef = useRef(groups);
  const callGroupIdRef = useRef<string | number | null>(null);
  const callPeerRef = useRef<string | null>(null);
  const callPeerNameRef = useRef<string>("");
  const endCallRef = useRef<(sendSignal?: boolean, explicitStatus?: "completed" | "missed" | "rejected") => void>(() => { });
  const isVideoCallRef = useRef(false);
  const isAppActiveRef = useRef(true);
  const seenMessageIds = useRef<Set<string>>(new Set<string>());
  const persistSeenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchingProfilesRef = useRef<Set<string>>(new Set());
  const openChatRef = useRef<(chat: Chat) => void>(() => { });
  const openChatByChatIdRef = useRef<(chatId: string) => void>(() => { });
  const readChatsRef = useRef<Set<string>>(new Set<string>());
  const initWSRef = useRef<(() => void) | null>(null);
  const acceptCallRef = useRef<() => void>(() => { });
  const rejectCallRef = useRef<() => void>(() => { });
  const wsHandlerRef = useRef<(raw: string) => void>(() => { });

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { callPeerRef.current = callPeer; }, [callPeer]);
  useEffect(() => { callPeerNameRef.current = callPeerName; }, [callPeerName]);
  useEffect(() => { isVideoCallRef.current = isVideoCall; }, [isVideoCall]);

  useEffect(() => {
    try {
      const ss = sessionStorage.getItem("Flux_seen_ids");
      if (ss) { seenMessageIds.current = new Set<string>(JSON.parse(ss)); return; }
      const ls = localStorage.getItem("Flux_seen_ids_android");
      if (ls) {
        const parsed = JSON.parse(ls) as { ids: string[]; ts: number };
        if (Date.now() - parsed.ts < 30 * 60 * 1000) seenMessageIds.current = new Set<string>(parsed.ids);
      }
    } catch { }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("Flux_read_chats");
      if (saved) readChatsRef.current = new Set<string>(JSON.parse(saved));
    } catch { }
  }, []);

  const addToReadChats = (chatId: string) => {
    readChatsRef.current.add(chatId);
    try { localStorage.setItem("Flux_read_chats", JSON.stringify([...readChatsRef.current])); } catch { }
  };

  const updateCallState = useCallback((newState: CallState) => {
    setCallState(newState);
    callStateRef.current = newState;
  }, []);

  const persistSeenIds = useCallback(() => {
    if (persistSeenTimer.current) clearTimeout(persistSeenTimer.current);
    persistSeenTimer.current = setTimeout(() => {
      try {
        if (seenMessageIds.current.size > 2000) seenMessageIds.current = new Set([...seenMessageIds.current].slice(-1000));
        const arr = [...seenMessageIds.current].slice(-1000);
        sessionStorage.setItem("Flux_seen_ids", JSON.stringify(arr));
        localStorage.setItem("Flux_seen_ids_android", JSON.stringify({ ids: arr, ts: Date.now() }));
      } catch { }
    }, 500);
  }, []);

  const updateActivity = useCallback((chatId: string | number, content: string, customTs?: number | string, skipActivityUpdate?: boolean) => {
    const id = String(chatId);
    if (!skipActivityUpdate) {
      let tsVal = Date.now();
      if (customTs) try { tsVal = typeof customTs === "number" ? customTs : parseTs(customTs as string).getTime(); } catch { }
      if (isNaN(tsVal)) tsVal = Date.now();
      setLastActivity(prev => {
        if (prev[id] && prev[id] > tsVal) return prev;
        const next = { ...prev, [id]: tsVal };
        if (currentUserRef.current) localStorage.setItem(`last_activity_${currentUserRef.current}`, JSON.stringify(next));
        return next;
      });
    }
    if (content && !content.startsWith("[")) {
      setLastPreview(prev => {
        const next = { ...prev, [id]: content };
        if (currentUserRef.current) localStorage.setItem(`last_preview_${currentUserRef.current}`, JSON.stringify(next));
        return next;
      });
    }
  }, []);

  const getPeerPubKey = useCallback(async (peerEmail: string): Promise<string | null> => {
    if (pubKeyCache.current.has(peerEmail)) return pubKeyCache.current.get(peerEmail)!;
    try {
      const data = await apiFetch<{ public_key: string }>(`/profile/public-key/${encodeURIComponent(peerEmail)}`);
      pubKeyCache.current.set(peerEmail, data.public_key);
      return data.public_key;
    } catch { return null; }
  }, [apiFetch]);

  const getGroupKey = useCallback(async (groupId: string | number): Promise<CryptoKey | null> => {
    const gid = String(groupId);
    if (groupKeyCache.has(gid)) return groupKeyCache.get(gid)!;
    const privKey = e2ePrivKeyRef.current;
    if (!privKey) return null;
    try {
      const data = await apiFetch<{ key_id: string; encrypted_key: string; setter_pub_key: string }>(`/groups/${gid}/e2e-key`);
      const groupKey = await unwrapGroupKey(data.encrypted_key, privKey, data.setter_pub_key);
      groupKeyCache.set(gid, groupKey);
      return groupKey;
    } catch { return null; }
  }, [apiFetch]);

  const decryptContent = useCallback(async (content: string, chatType: "user" | "group", peerEmail: string, groupId?: string | number): Promise<string> => {
    const privKey = e2ePrivKeyRef.current;
    if (!privKey) return content;
    try {
      if (isDMEncrypted(content)) {
        const theirPub = await getPeerPubKey(peerEmail);
        if (!theirPub) return "[Encrypted — peer key unavailable]";
        return await decryptDM(content, privKey, theirPub);
      }
      if (isGroupEncrypted(content) && groupId) {
        const groupKey = await getGroupKey(groupId);
        if (!groupKey) return "[Encrypted — group key unavailable]";
        return await decryptGroupMsg(content, groupKey);
      }
    } catch { return "[Encrypted message — decryption failed]"; }
    return content;
  }, [getPeerPubKey, getGroupKey]);

  // ── LOAD DATA ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    apiFetch<Record<string, number>>("/unread-counts").then(counts => {
      const id = activeChatRef.current ? String(activeChatRef.current.id) : null;
      const merged = { ...counts };
      readChatsRef.current.forEach(cid => { merged[cid] = 0; });
      if (id) merged[id] = 0;
      setUnread(merged);
    }).catch(() => {
      setUnread(safeParseJSON<Record<string, number>>(localStorage.getItem("cached_unread"), {}));
    });
    apiFetch<{ chat_id: string; chat_type: string; muted_until: string | null }[]>("/mutes").then(rows => {
      const map: Record<string, number | null> = {};
      rows.forEach(r => { map[r.chat_id] = r.muted_until ? new Date(r.muted_until).getTime() : null; });
      setMutedChats(map);
    }).catch(() => { });
  }, [token]); // eslint-disable-line

  useEffect(() => {
    if (!token) return;
    apiFetch<CallLogEntry[]>("/call-logs").then(apiLogs => {
      setCallLogs(prev => {
        const apiIdSet = new Set(apiLogs.map(l => l.id));
        const merged = [...apiLogs, ...prev.filter(l => !apiIdSet.has(l.id))];
        merged.sort((a, b) => parseTs(b.timestamp).getTime() - parseTs(a.timestamp).getTime());
        const final = merged.slice(0, 200);
        try { localStorage.setItem("cached_call_logs", JSON.stringify(final)); } catch { }
        return final;
      });
    }).catch(() => { });
  }, [token]); // eslint-disable-line

  useEffect(() => {
    if (!showStickers || !token || stickerPacks.length > 0) return;
    apiFetch<StickerPackMeta[]>("/stickers/packs").then(packs => {
      setStickerPacks(packs);
      if (packs.length > 0) setActiveStickerPack(packs[0].id);
    }).catch(() => { });
  }, [showStickers]); // eslint-disable-line

  useEffect(() => {
    if (!activeStickerPack || packStickers[activeStickerPack]) return;
    setLoadingStickers(true);
    apiFetch<StickerItem[]>(`/stickers/packs/${activeStickerPack}`)
      .then(items => setPackStickers(prev => ({ ...prev, [activeStickerPack]: items })))
      .catch(() => { })
      .finally(() => setLoadingStickers(false));
  }, [activeStickerPack]); // eslint-disable-line

  const loadProfile = useCallback(async () => {
    try {
      const data = await apiFetch<{ display_name: string; avatar_url: string; username: string }>("/profile/me");
      setProfile({ displayName: data.display_name || "", avatarUrl: data.avatar_url || "", username: data.username || "" });
      setEditDisplayName(data.display_name || "");
      setEditUsername(data.username || "");
    } catch { }
  }, [apiFetch]);

  const loadContacts = useCallback(async () => {
    try { setContacts(await apiFetch<Contact[]>("/contacts")); } catch { }
  }, [apiFetch]);

  const loadGroups = useCallback(async () => {
    try {
      const gs = await apiFetch<Group[]>("/groups");
      setGroups(gs.map(g => {
        const saved = typeof window !== "undefined" ? localStorage.getItem(`group_avatar_${g.id}`) : null;
        return saved ? { ...g, avatar_url: saved } : g;
      }));
    } catch { }
  }, [apiFetch]);

  const scrollBottom = useCallback(() => {
    const scroll = () => {
      if (msgListRef.current) msgListRef.current.scrollTop = msgListRef.current.scrollHeight;
      if (rowVirtualizerRef.current && groupedMessagesRef.current.length > 0) {
        try { rowVirtualizerRef.current.scrollToIndex(groupedMessagesRef.current.length - 1, { align: "end" }); } catch { }
      }
    };
    scroll();
    setTimeout(scroll, 50);
  }, []);

  const applyPersistedDeletions = useCallback((msgs: Message[]): Message[] => {
    const ids = deletedMsgIdsRef.current;
    if (ids.size === 0) return msgs;
    return msgs.map(m => ids.has(String(m.id)) ? { ...m, is_deleted: true } : m);
  }, []);

  const loadHistory = useCallback(async (chat: Chat, beforeId: string | number | null = null) => {
    if (!chat) return;
    setLoadingMore(true);
    if (!beforeId) setIsLoadingHistory(true);
    try {
      const { type, id } = chat;
      const base = type === "user" ? `/messages/direct/${encodeURIComponent(id)}` : `/messages/group/${id}`;
      const rawHistory = await apiFetch<Message[]>(base + (beforeId ? `?before_id=${beforeId}` : ""));
      const history = applyPersistedDeletions(rawHistory);
      const decryptedHistory = await Promise.all(
        history.map(async m => {
          if (!m.content || m.is_deleted || m._callRecord) return m;
          const peerEmail = type === "user" ? (m.user === currentUser ? String(id) : m.user) : m.user;
          const dec = await decryptContent(m.content, type, peerEmail, type === "group" ? id : undefined);
          return dec !== m.content ? { ...m, content: dec } : m;
        })
      );

      if (!beforeId) {
        const cachedDeleted = (messagesCacheRef.current[String(chat.id)] || []).filter(m => m.is_deleted);
        cachedDeleted.forEach(d => { if (!decryptedHistory.some(m => String(m.id) === String(d.id))) decryptedHistory.push(d); });
        decryptedHistory.sort((a, b) => parseTs(a.timestamp).getTime() - parseTs(b.timestamp).getTime());
      }

      if (beforeId) {
        const list = msgListRef.current;
        const prevScrollHeight = list ? list.scrollHeight : 0;
        const prevScrollTop = list ? list.scrollTop : 0;
        setMessages(prev => {
          const next = [...decryptedHistory, ...prev];
          setMessagesCache(cache => ({ ...cache, [String(chat.id)]: next }));
          return next;
        });
        requestAnimationFrame(() => requestAnimationFrame(() => { if (list) list.scrollTop = prevScrollTop + (list.scrollHeight - prevScrollHeight); }));
      } else {
        setMessages(decryptedHistory);
        setMessagesCache(cache => ({ ...cache, [String(chat.id)]: decryptedHistory }));
        if (decryptedHistory.length > 0) updateActivity(id, decryptedHistory[decryptedHistory.length - 1].content, decryptedHistory[decryptedHistory.length - 1].timestamp, true);
        setTimeout(scrollBottom, 100);
      }
      setHasMore(decryptedHistory.length === 50);
    } catch { }
    setLoadingMore(false);
    if (!beforeId) setIsLoadingHistory(false);
  }, [apiFetch, scrollBottom, updateActivity, applyPersistedDeletions, decryptContent, currentUser]);

  const isChatMuted = useCallback((chatId: string): boolean => {
    if (!(chatId in mutedChats)) return false;
    const until = mutedChats[chatId];
    return until === null ? true : until > Date.now();
  }, [mutedChats]);

  const notify = useCallback((title: string, body: string, chatId?: string) => {
    if (chatId && isChatMuted(chatId)) return;
    if (chatId && activeChatRef.current && String(activeChatRef.current.id) === chatId) return;
    playNotificationSound();
    if (IS_NATIVE || !isAppActiveRef.current || !document.hasFocus()) showLocalNotification(title, body, chatId);
  }, [playNotificationSound, isChatMuted]);

  const notifyCall = useCallback((title: string, body: string) => {
    showCallNotification(title, body);
  }, []);

  const markAllRead = useCallback(() => { setUnread({}); }, []);

  const contactLabelFn = useCallback((c: Contact) =>
    nicknames[c.email] || c.display_name || (c.username ? `@${c.username}` : null) || "Unknown User",
    [nicknames]);
  const contactLabel = contactLabelFn;

  const getPeerName = useCallback((email: string) => {
    const c = contacts.find(c => c.email === email);
    return c ? contactLabelFn(c) : "Unknown User";
  }, [contacts, contactLabelFn]);

  const applyAudioOutput = useCallback((speaker: boolean) => {
    if (IS_NATIVE && FluxNative) { (FluxNative as any).setAudioMode({ speaker }).catch(() => { }); return; }
    [remoteAudioRef.current, remoteVideoRef.current].forEach(el => {
      if (!el) return;
      if ("setSinkId" in el) (el as any).setSinkId(speaker ? "" : "communications").catch(() => { });
      el.volume = 1.0;
    });
  }, []);

  // ── AUTH HANDLERS ─────────────────────────────────────────────────────────────
  const handleSignIn = async () => {
    dispatchAuth({ type: "SET_ERROR", value: "" });
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: auth.email.trim(), password: auth.pass });
      if (error) throw error;
      const idToken = data.session?.access_token;
      if (!idToken) throw new Error("No session token");
      const res = await apiFetch<{ access_token: string; user: any }>("/auth/login", { method: "POST", body: JSON.stringify({ id_token: idToken }) });
      _finalizeAuth(res.access_token, res.user.email);
    } catch (e: any) {
      if (e.message?.includes("Account not found")) {
        const { data } = await supabase.auth.getSession();
        pendingSupabaseToken.current = data.session?.access_token || "";
        dispatchAuth({ type: "SET_STEP", step: "pick-username" });
      } else {
        dispatchAuth({ type: "SET_ERROR", value: e.message || "Sign in failed" });
      }
    } finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleSignUp = async () => {
    if (auth.pass !== auth.pass2) { dispatchAuth({ type: "SET_ERROR", value: "Passwords don't match" }); return; }
    if (auth.pass.length < 6) { dispatchAuth({ type: "SET_ERROR", value: "Password must be at least 6 characters" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { data, error } = await supabase.auth.signUp({ email: auth.email.trim(), password: auth.pass });
      if (error) throw error;
      const t = data.session?.access_token;
      if (!t) { dispatchAuth({ type: "SET_STEP", step: "verify-email" }); return; }
      pendingSupabaseToken.current = t;
      dispatchAuth({ type: "SET_STEP", step: "pick-username" });
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Sign up failed" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleRegister = async () => {
    const username = auth.user.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) { dispatchAuth({ type: "SET_ERROR", value: "Username must be 3–30 chars: lowercase letters, numbers, underscores only" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      if (!pendingSupabaseToken.current) {
        const { data } = await supabase.auth.getSession();
        pendingSupabaseToken.current = data.session?.access_token || "";
        if (!pendingSupabaseToken.current) { dispatchAuth({ type: "SET_ERROR", value: "Session expired" }); dispatchAuth({ type: "SET_STEP", step: "signin" }); return; }
      }
      const res = await apiFetch<{ access_token: string; user: any }>("/auth/register", { method: "POST", body: JSON.stringify({ id_token: pendingSupabaseToken.current, username, display_name: auth.user.trim() }) });
      _finalizeAuth(res.access_token, res.user.email);
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Registration failed" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleForgotPassword = async () => {
    if (!auth.email.trim()) { dispatchAuth({ type: "SET_ERROR", value: "Enter your email first" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const redirectTo = typeof window !== "undefined" ? window.location.origin : "com.yourapp://reset";
      const { error } = await supabase.auth.resetPasswordForEmail(auth.email.trim(), { redirectTo });
      if (error) throw error;
      dispatchAuth({ type: "SET_STEP", step: "verify-email" });
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Failed to send reset email" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const handleResetPassword = async () => {
    if (auth.pass !== auth.pass2) { dispatchAuth({ type: "SET_ERROR", value: "Passwords don't match" }); return; }
    if (auth.pass.length < 6) { dispatchAuth({ type: "SET_ERROR", value: "Password must be at least 6 characters" }); return; }
    dispatchAuth({ type: "SET_LOADING", value: true });
    try {
      const { error } = await supabase.auth.updateUser({ password: auth.pass });
      if (error) throw error;
      dispatchAuth({ type: "RESET" });
      showToast("Password updated! Sign in with your new password.", "success");
    } catch (e: any) { dispatchAuth({ type: "SET_ERROR", value: e.message || "Reset failed" }); }
    finally { dispatchAuth({ type: "SET_LOADING", value: false }); }
  };

  const _finalizeAuth = (accessToken: string, email: string) => {
    setToken(accessToken);
    setCurrentUser(email);
    localStorage.setItem("chat_user", email);
    pendingSupabaseToken.current = "";
    requestNotifyPermission();
    _registerFCMToken(accessToken);
    if (FluxNative) FluxNative.startService({ token: accessToken, wsUrl: API }).catch(() => { });
    getOrCreateIdentityKeyPair(email).then(({ privateKey, publicKeyB64 }) => {
      e2ePrivKeyRef.current = privateKey;
      e2ePubKeyB64Ref.current = publicKeyB64;
      apiFetch("/profile/public-key", { method: "POST", body: JSON.stringify({ public_key: publicKeyB64 }) }).catch(() => { });
    }).catch(() => { });
  };

  const _registerFCMToken = async (authToken: string) => {
    try {
      const fcmToken = await requestFCMPermission();
      if (fcmToken) {
        await fetch(`${API}/profile/fcm-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ fcm_token: fcmToken }),
        });
      }
    } catch { }
  };

  const logout = () => {
    abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    pendingTempTimers.current.forEach(t => clearTimeout(t));
    pendingTempTimers.current.clear();
    setFailedMsgIds(new Set());
    stopRingtone();
    supabase.auth.signOut().catch(() => { });
    if (FluxNative) FluxNative.stopService().catch(() => { });
    setToken(""); setCurrentUser(""); setMessages([]); setActiveChat(null); setContacts([]); setGroups([]); setUnread({});
    setSelectedMsgIds(new Set()); setForwardingMsgs([]);
    setProfile({ displayName: "", avatarUrl: "", username: "" }); setNicknames({}); setLastActivity({}); setLastPreview({});
    dispatchAuth({ type: "RESET" }); setShowHeaderNicknameEdit(false); setShowContactProfile(false);
    setShowGroupProfile(false); setShowMyProfileSettings(false); setSearchQuery("");
    localStorage.removeItem("chat_user");
    ["cached_contacts", "cached_groups", "cached_unread", "cached_call_logs", "Flux_seen_ids_android"].forEach(k => localStorage.removeItem(k));
    try { sessionStorage.removeItem("Flux_seen_ids"); sessionStorage.removeItem("_Flux_call_offer"); } catch { }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    setWsStatus("disconnected");
    seenMessageIds.current.clear();
  };

  const saveProfile = async () => {
    try {
      const body: any = {};
      if (editDisplayName.trim()) body.display_name = editDisplayName.trim();
      if (editUsername.trim() && editUsername.trim() !== profile.username) {
        const u = editUsername.trim().toLowerCase();
        if (!USERNAME_RE.test(u)) { showToast("Invalid username format", "error"); return; }
        body.username = u;
      }
      await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify(body) });
      setProfile(prev => ({ ...prev, displayName: editDisplayName.trim() || prev.displayName, username: body.username || prev.username }));
      setShowProfile(false);
      await loadProfile();
    } catch (err) { showToast("Failed to save profile: " + errorMessage(err), "error"); }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingAvatar(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      await apiFetch("/profile/me", { method: "PATCH", body: JSON.stringify({ avatar_url: data.url }) });
      setProfile(prev => ({ ...prev, avatarUrl: data.url }));
    } catch { showToast("Avatar upload failed", "error"); }
    finally { setIsUploadingAvatar(false); }
  };

  const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeChat || activeChat.type !== "group") return;
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingGroupAvatar(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      await apiFetch(`/groups/${activeChat.id}`, { method: "PATCH", body: JSON.stringify({ avatar_url: data.url }) });
      localStorage.setItem(`group_avatar_${activeChat.id}`, data.url);
      setGroups(prev => prev.map(g => g.id === activeChat.id ? { ...g, avatar_url: data.url } : g));
    } catch (err) { showToast("Group avatar upload failed: " + errorMessage(err), "error"); }
    finally { setIsUploadingGroupAvatar(false); e.target.value = ""; }
  };

  const addGroupMember = async (uname: string) => {
    if (!activeChat || activeChat.type !== "group" || !uname.trim()) return;
    try {
      const cleanedUname = uname.trim().replace(/^@/, "");
      let memberEmail = cleanedUname;
      if (!cleanedUname.includes("@")) {
        try {
          const prof = await apiFetch<{ email: string }>(`/profile/by-username/${encodeURIComponent(cleanedUname)}`);
          memberEmail = prof.email;
        } catch { showToast(`Username not found: @${cleanedUname}`, "error"); return; }
      }
      await apiFetch(`/groups/${activeChat.id}/members?member_email=${encodeURIComponent(memberEmail)}`, { method: "POST" });
      try {
        const privKey = e2ePrivKeyRef.current;
        const myPubB64 = e2ePubKeyB64Ref.current;
        const gid = String(activeChat.id);
        const existingKey = groupKeyCache.get(gid);
        if (privKey && myPubB64 && existingKey) {
          const newMemberPub = await getPeerPubKey(memberEmail);
          if (newMemberPub) {
            const keyId = crypto.randomUUID();
            const encKey = await wrapGroupKeyForMember({ keyId, groupKey: existingKey }, privKey, newMemberPub);
            await apiFetch(`/groups/${activeChat.id}/e2e-key`, { method: "POST", body: JSON.stringify({ key_id: keyId, setter_pub_key: myPubB64, member_keys: [{ email: memberEmail, encrypted_key: encKey }] }) });
          }
        }
      } catch { }
      await loadGroups();
    } catch (err) { showToast("Failed to add member: " + errorMessage(err), "error"); }
  };

  const addContactByUsername = async (username: string) => {
    if (!username.trim()) return;
    try {
      const res = await apiFetch<{ email: string; username: string; message: string }>("/contacts", { method: "POST", body: JSON.stringify({ username: username.trim().toLowerCase() }) });
      await loadContacts();
      const prof = await apiFetch<Contact>(`/profile/by-username/${username.trim().toLowerCase()}`);
      openChat({ type: "user", id: res.email, name: prof.display_name || prof.username || "Unknown User" });
    } catch (err) { showToast("Could not find user: " + errorMessage(err), "error"); }
  };

  const saveContactNickname = (email: string, nickname: string) => {
    const trimmed = nickname.trim();
    setNicknames(prev => {
      const next = { ...prev };
      if (trimmed) next[email] = trimmed; else delete next[email];
      if (currentUser) localStorage.setItem(`nicknames_${currentUser}`, JSON.stringify(next));
      return next;
    });
    setActiveChat(prev => {
      if (prev?.type === "user" && prev.id === email) {
        const c = contacts.find(c => c.email === email);
        return { ...prev, name: trimmed || c?.display_name || c?.username || "Unknown User" };
      }
      return prev;
    });
    setShowHeaderNicknameEdit(false);
  };

  const togglePinMessage = (msg: Message) => {
    if (!activeChat) return;
    const chatId = String(activeChat.id);
    const currentPinned = pinnedMessages[chatId] || [];
    const exists = currentPinned.some(m => m.id === msg.id);
    let nextPinned = [];
    if (exists) {
      nextPinned = currentPinned.filter(m => m.id !== msg.id);
      showToast("Message unpinned", "success");
    } else {
      nextPinned = [...currentPinned, msg];
      showToast("Message pinned", "success");
    }
    const next = { ...pinnedMessages, [chatId]: nextPinned };
    savePinnedMessages(next);
    setSelectedMsgId(null);

    // Send Real-time sync via WebSocket
    const wsSendPayload: any = {
      type: "pin_change",
      chat_id: chatId,
      action: exists ? "unpin" : "pin",
      msg: msg,
      user: currentUser
    };
    if (activeChat.type === "user") {
      wsSendPayload.target_user = chatId;
    } else {
      wsSendPayload.group_id = chatId;
    }
    wsSend(JSON.stringify(wsSendPayload));
  };

  const scrollToPinnedMessage = async (pinId: string | number) => {
    // 1. Check if already loaded
    let idx = groupedMessages.findIndex(m => m.type === "msg" && String(m.id) === String(pinId));
    if (idx !== -1) {
      rowVirtualizerRef.current?.scrollToIndex(idx, { align: "center" });
      setHighlightedMsgId(pinId);
      setTimeout(() => setHighlightedMsgId(null), 2000);
      return;
    }

    // 2. Load older history in batches until found or exhausted
    if (!activeChat) return;
    let currentMessages = messages;
    let found = false;
    let attempts = 0;
    const maxAttempts = 30;

    while (!found && currentMessages.length > 0 && attempts < maxAttempts) {
      attempts++;
      const oldestMsg = currentMessages[0];
      if (!oldestMsg) break;

      showToast("Loading older history...", "info");
      const beforeId = oldestMsg.id;
      const { type, id } = activeChat;
      const base = type === "user" ? `/messages/direct/${encodeURIComponent(id)}` : `/messages/group/${id}`;

      try {
        const rawHistory = await apiFetch<Message[]>(base + `?before_id=${beforeId}`);
        if (rawHistory.length === 0) break;

        const history = applyPersistedDeletions(rawHistory);
        const decryptedHistory = await Promise.all(
          history.map(async m => {
            if (!m.content || m.is_deleted || m._callRecord) return m;
            const peerEmail = type === "user" ? (m.user === currentUser ? String(id) : m.user) : m.user;
            const dec = await decryptContent(m.content, type, peerEmail, type === "group" ? id : undefined);
            return dec !== m.content ? { ...m, content: dec } : m;
          })
        );

        let updatedMessages: Message[] = [];
        setMessages(prev => {
          updatedMessages = [...decryptedHistory, ...prev];
          setMessagesCache(cache => ({ ...cache, [String(id)]: updatedMessages }));
          return updatedMessages;
        });

        // Wait for virtualizer and state update to flush to DOM
        await new Promise(resolve => setTimeout(resolve, 150));

        idx = groupedMessagesRef.current.findIndex(m => m.type === "msg" && String(m.id) === String(pinId));
        if (idx !== -1) {
          found = true;
          rowVirtualizerRef.current?.scrollToIndex(idx, { align: "center" });
          setHighlightedMsgId(pinId);
          setTimeout(() => setHighlightedMsgId(null), 2000);
          break;
        }
        currentMessages = updatedMessages;
      } catch {
        break;
      }
    }

    if (!found) {
      showToast("Message not found in loaded history", "info");
    }
  };

  const openHeaderNicknameEdit = () => {
    if (!activeChat || activeChat.type !== "user") return;
    setHeaderNicknameValue(nicknames[String(activeChat.id)] || "");
    setShowHeaderNicknameEdit(true);
    setShowContactProfile(false);
  };

  const deleteChat = useCallback((type: "user" | "group", id: string | number) => {
    const sid = String(id);
    setSidebarDeleteId(null);
    setMessagesCache(cache => { const next = { ...cache }; delete next[sid]; return next; });
    setLastActivity(prev => { const n = { ...prev }; delete n[sid]; return n; });
    setLastPreview(prev => { const n = { ...prev }; delete n[sid]; return n; });
    setUnread(prev => { const n = { ...prev }; delete n[sid]; return n; });
    if (type === "user") setContacts(prev => prev.filter(c => c.email !== sid));
    else setGroups(prev => prev.filter(g => String(g.id) !== sid));
    if (activeChat && String(activeChat.id) === sid) { setActiveChat(null); setMessages([]); }
    apiFetch(type === "user" ? `/conversations/user/${encodeURIComponent(sid)}` : `/conversations/group/${sid}`, { method: "DELETE" }).catch(() => { });
  }, [activeChat, apiFetch]);

  const sendReadReceipt = useCallback(async (chat: Chat) => {
    const chatId = String(chat.id);
    const sendWS = (payload: object) => { wsSend(JSON.stringify(payload)); };
    try {
      if (chat.type === "user") {
        await apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ peer_email: chatId }) });
        sendWS({ type: "read_receipt", target_user: chatId });
      } else {
        await apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ group_id: chatId }) });
        sendWS({ type: "read_receipt", group_id: chatId });
      }
    } catch {
      setTimeout(async () => {
        try {
          if (chat.type === "user") { await apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ peer_email: chatId }) }); sendWS({ type: "read_receipt", target_user: chatId }); }
          else await apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ group_id: chatId }) });
        } catch { }
      }, 3000);
    }
  }, [apiFetch]);

  const openChat = useCallback(async (chat: Chat) => {
    const chatId = String(chat.id);
    setActiveChat(chat);
    setShowHeaderNicknameEdit(false); setShowContactProfile(false); setShowGroupProfile(false);
    setSearchQuery(""); setReplyingTo(null); setReactionPickerId(null); setSelectedMsgId(null);
    setSelectedMsgIds(new Set()); setForwardingMsgs([]);
    setSidebarDeleteId(null); setOpenedProfileFromSidebar(false);
    if (messagesCacheRef.current[chatId]) { setMessages(messagesCacheRef.current[chatId]); setTimeout(scrollBottom, 10); }
    else setMessages([]);
    setHasMore(false); setShowEmojis(false); setEditingId(null);
    addToReadChats(chatId);
    setUnread(prev => ({ ...prev, [chatId]: 0 }));
    sendReadReceipt(chat);
    await loadHistory(chat);
    if (chat.type === "user" && e2ePrivKeyRef.current) getPeerPubKey(String(chat.id)).catch(() => { });
    else if (chat.type === "group" && e2ePrivKeyRef.current) getGroupKey(chat.id).catch(() => { });
    setMessages(prev => {
      const next = prev.map(m => m.user !== currentUser && !m.is_read ? { ...m, is_read: true } : m);
      setMessagesCache(cache => ({ ...cache, [chatId]: next }));
      return next;
    });
    setTimeout(scrollBottom, 150);
  }, [scrollBottom, loadHistory, currentUser, sendReadReceipt, getPeerPubKey, getGroupKey]);

  useEffect(() => { openChatRef.current = openChat; }, [openChat]);

  const openChatByChatId = useCallback((chatId: string) => {
    if (!chatId) return;
    if (chatId.includes("@")) {
      const c = contactsRef.current.find(co => co.email === chatId);
      const name = c ? contactLabelFn(c) : chatId;
      openChatRef.current({ type: "user", id: chatId, name });
    } else {
      const g = groupsRef.current.find(gr => String(gr.id) === String(chatId));
      const name = g ? g.name : "Group Chat";
      openChatRef.current({ type: "group", id: isNaN(Number(chatId)) ? chatId : Number(chatId), name });
    }
  }, [contactLabelFn]);

  useEffect(() => { openChatByChatIdRef.current = openChatByChatId; }, [openChatByChatId]);

  // ── BACK BUTTON / OVERLAY MANAGEMENT ─────────────────────────────────────────
  useEffect(() => {
    const anyOverlayOpen = showEmojis || showContactProfile || showGroupProfile || showCallLogUI || showProfile || showMyProfileSettings || !!viewFile || reactionPickerId !== null;
    if (anyOverlayOpen) window.history.pushState({ Flux_Overlay: true }, "");
    const handlePopState = () => {
      if (showEmojis) { setShowEmojis(false); return; }
      if (reactionPickerId !== null) { setReactionPickerId(null); return; }
      if (viewFile) { setViewFile(null); return; }
      if (showContactProfile) {
        setShowContactProfile(false);
        if (openedProfileFromSidebar) { setActiveChat(null); setOpenedProfileFromSidebar(false); }
        return;
      }
      if (showGroupProfile) {
        setShowGroupProfile(false);
        if (openedProfileFromSidebar) { setActiveChat(null); setOpenedProfileFromSidebar(false); }
        return;
      }
      if (showCallLogUI) { setShowCallLogUI(false); return; }
      if (showProfile) { setShowProfile(false); return; }
      if (showMyProfileSettings) { setShowMyProfileSettings(false); return; }
      if (activeChat) { setActiveChat(null); return; }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [showEmojis, showContactProfile, showGroupProfile, showCallLogUI, showProfile, showMyProfileSettings, viewFile, reactionPickerId, activeChat, openedProfileFromSidebar]);

  // ── LOAD MORE (Intersection Observer) ────────────────────────────────────────
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loadingMore && messages.length > 0 && activeChat) loadHistory(activeChat, messages[0].id);
    }, { root: msgListRef.current, threshold: 0, rootMargin: "80px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, messages, activeChat, loadHistory]);

  // ── WS SEND ───────────────────────────────────────────────────────────────────
  const wsSend = useCallback((payload: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload);
    } else {
      pendingMessages.current.push(payload);
      if (!wsRef.current || wsRef.current.readyState >= WebSocket.CLOSING) initWSRef.current?.();
    }
  }, []);

  // ── REMOVE PEER FROM CALL ─────────────────────────────────────────────────────
  const removePeerFromCall = useCallback((peerEmail: string) => {
    const pc = pcMapRef.current.get(peerEmail);
    if (pc) { try { pc.close(); } catch { } pcMapRef.current.delete(peerEmail); }
    setRemoteStreams(prev => { const next = { ...prev }; delete next[peerEmail]; return next; });
    if (!callGroupIdRef.current || pcMapRef.current.size === 0) {
      endCallRef.current(false, callStateRef.current === "connected" ? "completed" : "missed");
    }
  }, []);

  const endCall = useCallback((sendSignal = true, explicitStatus?: "completed" | "missed" | "rejected") => {
    stopRingtone();
    cancelCallNotification();
    acceptInProgressRef.current = false;
    if (IS_NATIVE && FluxNative) (FluxNative as any).stopCallAudio().catch(() => { });
    if (FluxNative) FluxNative.stopCall().catch(() => { });
    try { sessionStorage.removeItem("_Flux_call_offer"); } catch { }

    const finalStatus = explicitStatus || (callStateRef.current === "connected" ? "completed" : "missed");
    const duration = callStartTimeRef.current && callStateRef.current === "connected"
      ? Math.floor((Date.now() - callStartTimeRef.current) / 1000) : 0;
    const cp = callPeerRef.current;
    const cpName = callPeerNameRef.current;

    if (cp && callDirectionRef.current) {
      const resolvedName = cpName || getPeerName(cp) || cp;
      const newLog: CallLogEntry = {
        id: Date.now().toString() + Math.random(), peer: cp, peerName: resolvedName,
        direction: callDirectionRef.current, media: isVideoCallRef.current ? "video" : "audio",
        status: finalStatus, timestamp: new Date().toISOString(), duration,
      };
      setCallLogs(prev => {
        const next = [newLog, ...prev];
        try { localStorage.setItem("cached_call_logs", JSON.stringify(next.slice(0, 200))); } catch { }
        return next;
      });
      apiFetch("/call-logs", { method: "POST", body: JSON.stringify(newLog) }).catch(() => { });

      const icon = isVideoCallRef.current ? "📹" : "📞";
      const callTypeLabel = isVideoCallRef.current ? "Video call" : "Voice call";
      const statusLabel = finalStatus === "completed" ? ` · ${fmtDuration(duration)}` : finalStatus === "rejected" ? " · Declined" : " · Missed";
      const recordContent = `${icon} ${callDirectionRef.current === "incoming" ? "Incoming" : "Outgoing"} ${callTypeLabel}${statusLabel}`;
      const callRecord: Message = { id: `call-${Date.now()}-${Math.random()}`, user: currentUserRef.current, content: recordContent, timestamp: new Date().toISOString(), _callRecord: true };
      const targetChatId = activeChatRef.current ? String(activeChatRef.current.id) : cp || "";
      if (targetChatId) setMessages(prev => { const next = [...prev, callRecord]; setMessagesCache(cache => ({ ...cache, [targetChatId]: next })); return next; });
      setTimeout(scrollBottom, 50);
    }

    if (sendSignal) {
      if (pcMapRef.current.size > 0) pcMapRef.current.forEach((_, peerEmail) => wsSend(JSON.stringify({ type: "call_end", target_user: peerEmail })));
      else if (cp) wsSend(JSON.stringify({ type: "call_end", target_user: cp }));
    }

    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    pcMapRef.current.forEach(pc => pc.close());
    pcMapRef.current.clear();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    peerConnectionRef.current = null; pendingRemoteDescriptionRef.current = null;
    localStreamRef.current = null; remoteStreamRef.current = null;
    iceCandidateQueueRef.current = []; iceQueuesRef.current.clear(); pendingMeshOffersRef.current.clear();

    setRemoteStreams({}); setCameraStates({});
    updateCallState("idle"); setCallPeer(null); setCallPeerName("");
    setIsMuted(false); setIsSpeaker(false); setIsCameraOff(false); setRemoteVideoMuted(false);
    setFacingMode("user"); setCallDuration(0); setIsVideoSwapped(false);
    callStartTimeRef.current = null; callDirectionRef.current = null; isVideoCallRef.current = false;
    callGroupIdRef.current = null; setPipPos({ x: 16, y: 100 });
  }, [updateCallState, stopRingtone, scrollBottom, getPeerName, apiFetch]); // eslint-disable-line

  useEffect(() => { endCallRef.current = endCall; }, [endCall]);

  const restoreCallOfferFromStorage = useCallback(() => {
    try {
      const stored = sessionStorage.getItem("_Flux_call_offer");
      if (!stored) return false;
      const parsed: StoredCallOffer = JSON.parse(stored);
      if (Date.now() - parsed.ts > 55_000) { sessionStorage.removeItem("_Flux_call_offer"); return false; }
      if (callStateRef.current !== "idle") return false;
      const sdpObj = (parsed.sdp && typeof parsed.sdp === "object") ? parsed.sdp as any : {};
      const offerGroupId = parsed.group_id || sdpObj.group_id;
      if (offerGroupId) callGroupIdRef.current = offerGroupId;
      const realSdp = sdpObj.sdp ? { type: sdpObj.type, sdp: sdpObj.sdp } : parsed.sdp;
      pendingRemoteDescriptionRef.current = realSdp;
      setCallPeer(parsed.peer); setCallPeerName(parsed.peerName);
      setIsVideoCall(parsed.isVideo); isVideoCallRef.current = parsed.isVideo;
      callDirectionRef.current = "incoming";
      updateCallState("incoming");
      startRingtone();
      notifyCall(parsed.isVideo ? "📹 Incoming Video Call" : "📞 Incoming Voice Call", `${parsed.peerName} is calling…`);
      return true;
    } catch { return false; }
  }, [updateCallState, startRingtone, notifyCall]);

  // ── WEBSOCKET ─────────────────────────────────────────────────────────────────
  const initWS = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;
    if (wsPingInterval.current) { clearInterval(wsPingInterval.current); wsPingInterval.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    setWsStatus("reconnecting");

    let ws: WebSocket;
    try { ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(currentToken)}`); wsRef.current = ws; }
    catch { setWsStatus("disconnected"); return; }

    ws.onopen = () => {
      wsRetryDelay.current = 800; wsRetryCount.current = 0;
      setWsStatus("connected");
      if (!IS_NATIVE && ringtoneRef.current) ringtoneRef.current.load();
      if (IS_NATIVE) preloadSounds();

      if (IS_NATIVE && FluxNative) {
        (FluxNative as any).getPendingAccept?.()
          .then((res: { pending: boolean; offerData: string }) => {
            if (!res.pending || !res.offerData || callStateRef.current !== "idle") return;
            try {
              const offer = JSON.parse(res.offerData);
              if (!offer.sdp || !offer.peer) return;
              pendingRemoteDescriptionRef.current = offer.sdp;
              callPeerRef.current = offer.peer; callPeerNameRef.current = offer.peerName || offer.peer;
              isVideoCallRef.current = !!offer.isVideo; callDirectionRef.current = "incoming";
              setCallPeer(offer.peer); setCallPeerName(offer.peerName || offer.peer);
              setIsVideoCall(!!offer.isVideo); updateCallState("incoming");
              setTimeout(() => acceptCallRef.current(), 100);
            } catch { }
          })
          .catch(() => { });
      }

      if (seenMessageIds.current.size > 2000) seenMessageIds.current = new Set([...seenMessageIds.current].slice(-1000));
      persistSeenIds();
      lastPongRef.current = Date.now();

      wsPingInterval.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongRef.current > 35000) { ws.close(); return; }
        ws.send(JSON.stringify({ type: "ping" }));
      }, 20000);

      while (pendingMessages.current.length > 0) {
        const queued = pendingMessages.current.shift();
        if (queued && ws.readyState === WebSocket.OPEN) ws.send(queued);
      }

      apiFetch<Record<string, number>>("/unread-counts").then(counts => {
        setUnread(() => {
          const merged = { ...counts };
          const id = activeChatRef.current ? String(activeChatRef.current.id) : null;
          readChatsRef.current.forEach(cid => { merged[cid] = 0; });
          if (id) merged[id] = 0;
          return merged;
        });
      }).catch(() => { });

      const openChatNow = activeChatRef.current;
      if (openChatNow && ws.readyState === WebSocket.OPEN) {
        if (openChatNow.type === "user") {
          apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ peer_email: String(openChatNow.id) }) })
            .then(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "read_receipt", target_user: openChatNow.id })); })
            .catch(() => { });
        } else {
          apiFetch("/mark-read", { method: "POST", body: JSON.stringify({ group_id: String(openChatNow.id) }) }).catch(() => { });
        }
      }
    };

    ws.onerror = () => { };

    ws.onclose = (e) => {
      if (wsPingInterval.current) { clearInterval(wsPingInterval.current); wsPingInterval.current = null; }
      const hasToken = !!tokenRef.current;
      const tooMany = wsRetryCount.current >= 10;
      if (!hasToken) { setTimeout(() => setWsStatus("disconnected"), 0); return; }
      if (tooMany) { setTimeout(() => setWsStatus("offline"), 0); return; }
      wsRetryCount.current += 1;
      const delay = wsRetryDelay.current;
      wsRetryDelay.current = Math.min(delay * 1.5, 5000);
      setTimeout(() => {
        setWsStatus("disconnected");
        setTimeout(() => {
          if (!tokenRef.current || wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
          setWsStatus("reconnecting");
          requestAnimationFrame(() => initWSRef.current?.());
        }, delay);
      }, 0);
    };

    ws.onmessage = ({ data: raw }) => {
      try { const parsed = JSON.parse(raw); if (parsed.type === "pong") { lastPongRef.current = Date.now(); return; } } catch { return; }
      setTimeout(() => wsRef.current && wsHandlerRef.current(raw), 0);
    };
  }, [apiFetch, persistSeenIds]); // eslint-disable-line

  // ── WS MESSAGE HANDLER ────────────────────────────────────────────────────────
  const wsHandler = useCallback(async (raw: string) => {
    let data: Partial<Message> & Record<string, unknown>;
    try { data = JSON.parse(raw); } catch { return; }
    const me = currentUserRef.current;

    const updateMsgCache = (targetChatId: string, updater: (msgs: Message[]) => Message[]) => {
      setMessages(prev => {
        const next = updater(prev);
        setMessagesCache(cache => ({ ...cache, [targetChatId]: next }));
        return next;
      });
    };

    switch (data.type) {
      case "typing":
        if (typeof data.user === "string" && data.user !== me) {
          setTypingSet(prev => new Set(prev).add(data.user as string));
          setTimeout(() => setTypingSet(prev => { const n = new Set(prev); n.delete(data.user as string); return n; }), 2000);
        }
        break;

      case "pin_change": {
        const isGroup = !!data.group_id;
        const sender = data.user || data.sender;
        const pinChatId = isGroup
          ? String(data.group_id || data.chat_id)
          : (sender === me ? String(data.target_user) : String(sender));
        const pinAction = String(data.action);
        const pinMsg = data.msg as Message;
        if (pinChatId && pinMsg) {
          setPinnedMessages(prev => {
            const currentPinned = prev[pinChatId] || [];
            let nextPinned = [];
            if (pinAction === "pin") {
              if (!currentPinned.some(m => m.id === pinMsg.id)) {
                nextPinned = [...currentPinned, pinMsg];
              } else {
                nextPinned = currentPinned;
              }
            } else {
              nextPinned = currentPinned.filter(m => m.id !== pinMsg.id);
            }
            const next = { ...prev, [pinChatId]: nextPinned };
            if (currentUserRef.current) {
              try {
                localStorage.setItem(`pinned_msgs_${currentUserRef.current}`, JSON.stringify(next));
              } catch { }
            }
            return next;
          });
        }
        break;
      }

      case "direct_message": {
        setTypingSet(prev => { const n = new Set(prev); n.delete(String(data.user)); return n; });
        const peer = data.user === me ? (data.receiver_email || data.target_user) : data.user;
        if (!peer) break;
        if (data.user !== me && blockedUsersRef.current.has(String(data.user))) break;
        const rawMsg = data as Message;
        const dmPeer = data.user === me ? String(data.receiver_email || data.target_user) : String(data.user);
        const decContent = await decryptContent(rawMsg.content, "user", dmPeer);
        const msg = { ...rawMsg, content: decContent };
        const dmId = String(msg.id);
        if (!dmId.startsWith("temp-") && seenMessageIds.current.has(dmId)) break;
        if (!dmId.startsWith("temp-")) { seenMessageIds.current.add(dmId); persistSeenIds(); }
        updateActivity(String(peer), msg.content, msg.timestamp);
        const peerEmail = String(peer);
        const contactExists = contactsRef.current.some(c => c.email === peerEmail);
        if (!contactExists) {
          setContacts(prev => {
            if (prev.find(c => c.email === peerEmail)) return prev;
            return [...prev, { email: peerEmail, display_name: (data.sender_name as string) || null, avatar_url: (data.sender_avatar as string) || null, is_online: true, username: null }];
          });
          apiFetch("/contacts/by-email", { method: "POST", body: JSON.stringify({ email: peerEmail }) })
            .then(() => loadContacts())
            .catch(() => { });
          if (!fetchingProfilesRef.current.has(peerEmail)) {
            fetchingProfilesRef.current.add(peerEmail);
            apiFetch<Contact>(`/profile/${encodeURIComponent(peerEmail)}`)
              .then(prof => setContacts(prev => prev.map(c => c.email === peerEmail ? { ...c, ...prof } : c)))
              .catch(() => { })
              .finally(() => fetchingProfilesRef.current.delete(peerEmail));
          }
        }
        const isInPeerChat = activeChatRef.current?.type === "user" && String(activeChatRef.current.id) === String(peer);
        if (isInPeerChat) {
          lastReplacedTempRef.current = null;
          updateMsgCache(String(peer), prev => {
            if (data.user === me) {
              const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
              if (idx !== -1) { lastReplacedTempRef.current = String(prev[idx].id); const next = [...prev]; next[idx] = msg; return next; }
              if (!prev.find(m => String(m.id) === String(msg.id))) return [...prev, msg];
              return prev;
            }
            if (!prev.find(m => String(m.id) === String(msg.id))) return [...prev, msg];
            return prev;
          });
          const replacedId = lastReplacedTempRef.current;
          if (replacedId) { const t = pendingTempTimers.current.get(replacedId); if (t) { clearTimeout(t); pendingTempTimers.current.delete(replacedId); } setFailedMsgIds(prev => { const n = new Set(prev); n.delete(replacedId); return n; }); }
          setTimeout(scrollBottom, 50);
          if (data.user !== me && activeChatRef.current) sendReadReceipt(activeChatRef.current);
        } else {
          setMessagesCache(prev => {
            const currentList = prev[String(peer)];
            if (!currentList) return prev;
            if (currentList.find(m => String(m.id) === String(msg.id))) return prev;
            let nextList = currentList;
            if (data.user === me) {
              const idx = currentList.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
              nextList = idx !== -1 ? [...currentList.slice(0, idx), msg, ...currentList.slice(idx + 1)] : [...currentList, msg];
            } else { nextList = [...currentList, msg]; }
            return { ...prev, [String(peer)]: nextList };
          });
          if (data.user !== me) {
            setUnread(prev => ({ ...prev, [String(peer)]: (prev[String(peer)] || 0) + 1 }));
            notify((data.sender_name as string) || "New message", msg.content.startsWith("[") ? "📎 Attachment" : msg.content, String(peer));
          }
        }
        break;
      }

      case "group_message": {
        const rawGMsg = data as Message;
        const decContent = await decryptContent(rawGMsg.content, "group", String(rawGMsg.user), rawGMsg.group_id);
        const msg = { ...rawGMsg, content: decContent };
        const gmId = String((data as any).id);
        if (gmId && !gmId.startsWith("temp-") && seenMessageIds.current.has(gmId)) break;
        if (gmId && !gmId.startsWith("temp-")) { seenMessageIds.current.add(gmId); persistSeenIds(); }
        updateActivity(String(data.group_id), msg.content, msg.timestamp);
        const groupIdStr = String(data.group_id);
        const groupExists = groupsRef.current.some(g => String(g.id) === groupIdStr);
        if (!groupExists) {
          loadGroups();
        }
        const isInGroupChat = activeChatRef.current?.type === "group" && String(activeChatRef.current.id) === String(data.group_id);
        if (isInGroupChat) {
          lastReplacedTempRef.current = null;
          updateMsgCache(String(data.group_id), prev => {
            if (data.user === me) {
              const idx = prev.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
              if (idx !== -1) { lastReplacedTempRef.current = String(prev[idx].id); const next = [...prev]; next[idx] = msg; return next; }
              if (!prev.find(m => String(m.id) === String(msg.id))) return [...prev, msg];
              return prev;
            }
            if (!prev.find(m => String(m.id) === String(msg.id))) return [...prev, msg];
            return prev;
          });
          const replacedId = lastReplacedTempRef.current;
          if (replacedId) { const t = pendingTempTimers.current.get(replacedId); if (t) { clearTimeout(t); pendingTempTimers.current.delete(replacedId); } setFailedMsgIds(prev => { const n = new Set(prev); n.delete(replacedId); return n; }); }
          setTimeout(scrollBottom, 50);
        } else {
          setMessagesCache(prev => {
            const currentList = prev[String(data.group_id)];
            if (!currentList) return prev;
            if (currentList.find(m => String(m.id) === String(msg.id))) return prev;
            let nextList = currentList;
            if (data.user === me) {
              const idx = currentList.findIndex(m => String(m.id).startsWith("temp-") && m.content === msg.content);
              nextList = idx !== -1 ? [...currentList.slice(0, idx), msg, ...currentList.slice(idx + 1)] : [...currentList, msg];
            } else { nextList = [...currentList, msg]; }
            return { ...prev, [String(data.group_id)]: nextList };
          });
          if (data.user !== me) {
            setUnread(prev => ({ ...prev, [String(data.group_id)]: (prev[String(data.group_id)] || 0) + 1 }));
            notify(`${data.group_name}`, `${data.sender_name || "Someone"}: ${msg.content.startsWith("[") ? "📎 Attachment" : msg.content}`, String(data.group_id));
          }
        }
        break;
      }

      case "reaction":
        setMessages(prev => {
          const next = prev.map(m => {
            if (String(m.id) !== String(data.message_id)) return m;
            if (data.reactions && typeof data.reactions === "object") return { ...m, reactions: data.reactions as Record<string, string[]> };
            if (data.user && data.emoji) return { ...m, reactions: updateReactionsForUser(m.reactions, String(data.user), String(data.emoji)) };
            return m;
          });
          if (activeChatRef.current) setMessagesCache(cache => ({ ...cache, [String(activeChatRef.current!.id)]: next }));
          return next;
        });
        break;

      case "read_receipt":
        setMessages(prev => {
          const next = prev.map(m => {
            if (m.user !== me) return m;
            if (data.group_id && m.group_id === data.group_id) {
              const rb = m.read_by || [];
              if (!rb.includes(String(data.user))) return { ...m, is_read: true, read_by: [...rb, String(data.user)] };
            } else if (!data.group_id && !m.group_id) return { ...m, is_read: true };
            return m;
          });
          if (activeChatRef.current) setMessagesCache(cache => ({ ...cache, [String(activeChatRef.current!.id)]: next }));
          return next;
        });
        break;

      case "message_edited": {
        const rawMsg = data as Message;
        const chatType = data.group_id ? "group" : "user";
        const peerEmail = chatType === "user" ? (data.user === me ? String(data.receiver_email || data.target_user) : String(data.user)) : String(data.user);
        const decContent = await decryptContent(rawMsg.content, chatType, peerEmail, data.group_id ? String(data.group_id) : undefined);
        const targetChatId = data.group_id ? String(data.group_id) : peerEmail;
        setMessages(prev => {
          const next = prev.map(m => String(m.id) === String(data.id) ? { ...m, content: decContent, edited_at: data.edited_at as string } : m);
          setMessagesCache(cache => ({ ...cache, [targetChatId]: next }));
          return next;
        });
        break;
      }

      case "message_deleted": {
        const targetChatId = data.group_id ? String(data.group_id) : (activeChatRef.current ? String(activeChatRef.current.id) : "");
        setMessages(prev => {
          const next = prev.map(m => String(m.id) === String(data.id) ? { ...m, is_deleted: true } : m);
          if (targetChatId) setMessagesCache(cache => ({ ...cache, [targetChatId]: next }));
          return next;
        });
        break;
      }

      case "presence":
        setContacts(prev => prev.map(c => c.email === data.user ? { ...c, is_online: Boolean(data.online) } : c));
        break;

      case "call_offer": {
        const callerEmail = String(data.user || "");
        if (blockedUsersRef.current.has(callerEmail)) {
          if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "call_reject", target_user: callerEmail }));
          break;
        }
        const vid = Boolean(data.isVideo);
        const sdpObj = (data.sdp && typeof data.sdp === "object") ? data.sdp as any : {};
        const isMesh = Boolean(data.is_mesh || sdpObj.is_mesh);
        const offerGroupId = data.group_id || sdpObj.group_id;
        const offerSenderName = data.sender_name || sdpObj.sender_name;
        const realSdp = sdpObj.sdp ? { type: sdpObj.type, sdp: sdpObj.sdp } : data.sdp;

        if (isMesh) {
          if (callStateRef.current === "connected") {
            if (!pcMapRef.current.has(callerEmail)) {
              try {
                const meshPc = await setupWebRTC(callerEmail);
                await meshPc.setRemoteDescription(new RTCSessionDescription(realSdp as RTCSessionDescriptionInit));
                const queue = iceQueuesRef.current.get(callerEmail) || [];
                while (queue.length > 0) { const c = queue.shift(); if (c) await meshPc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); }
                iceQueuesRef.current.set(callerEmail, queue);
                const meshAnswer = await meshPc.createAnswer();
                await meshPc.setLocalDescription(meshAnswer);
                wsSend(JSON.stringify({ type: "call_answer", target_user: callerEmail, sdp: meshAnswer }));
              } catch { }
            }
          } else {
            pendingMeshOffersRef.current.set(callerEmail, realSdp as RTCSessionDescriptionInit);
          }
          break;
        }

        iceCandidateQueueRef.current = [];
        iceQueuesRef.current.clear();
        if (callStateRef.current === "idle") pendingMeshOffersRef.current.clear();
        if (offerGroupId) callGroupIdRef.current = offerGroupId as string | number;

        const existingContact = contactsRef.current.find(c => c.email === callerEmail);
        const callerDisplayName = String(offerSenderName || "").trim() || (existingContact ? contactLabelFn(existingContact) : "") || callerEmail.split("@")[0] || "Incoming Call";
        const offerPayload: StoredCallOffer = { sdp: realSdp as RTCSessionDescriptionInit, peer: callerEmail, peerName: callerDisplayName, isVideo: vid, ts: Date.now(), group_id: offerGroupId as string | number };

        try { sessionStorage.setItem("_Flux_call_offer", JSON.stringify(offerPayload)); } catch { }
        setCallPeer(callerEmail); setCallPeerName(callerDisplayName);
        callPeerRef.current = callerEmail; callPeerNameRef.current = callerDisplayName;
        setIsVideoCall(vid); isVideoCallRef.current = vid;
        updateCallState("incoming"); callDirectionRef.current = "incoming";
        pendingRemoteDescriptionRef.current = realSdp as RTCSessionDescriptionInit;
        startRingtone();
        notifyCall(vid ? "📹 Incoming Video Call" : "📞 Incoming Voice Call", `${callerDisplayName} is calling…`);

        if (!existingContact?.display_name) {
          apiFetch<Contact>(`/profile/${encodeURIComponent(callerEmail)}`).then(prof => {
            const richName = prof.display_name || (prof.username ? `@${prof.username}` : "") || callerDisplayName;
            setCallPeerName(richName);
            try { sessionStorage.setItem("_Flux_call_offer", JSON.stringify({ ...offerPayload, peerName: richName })); } catch { }
          }).catch(() => { });
        }
        break;
      }

      case "call_answer": {
        const peer = String(data.user);
        const pc = pcMapRef.current.get(peer) || peerConnectionRef.current;
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp as RTCSessionDescriptionInit));
          updateCallState("connected"); callStartTimeRef.current = Date.now();
          const queue = iceQueuesRef.current.get(peer) || [];
          while (queue.length > 0) { const c = queue.shift(); if (c) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); }
          iceQueuesRef.current.set(peer, queue);
        }
        break;
      }

      case "ice_candidate": {
        const peer = String(data.user);
        const pc = pcMapRef.current.get(peer) || peerConnectionRef.current;
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate as RTCIceCandidateInit)).catch(console.error);
        } else {
          const queue = iceQueuesRef.current.get(peer) || [];
          queue.push(data.candidate as RTCIceCandidateInit);
          iceQueuesRef.current.set(peer, queue);
        }
        break;
      }

      case "camera_state": {
        const u = String(data.user || "");
        setRemoteVideoMuted(data.videoMuted === true);
        if (u) setCameraStates(prev => ({ ...prev, [u]: data.videoMuted === true }));
        break;
      }

      case "call_end": {
        const leavingPeer = String(data.user || "");
        const inGroupCall = !!callGroupIdRef.current;
        if (inGroupCall && pcMapRef.current.has(leavingPeer)) {
          removePeerFromCall(leavingPeer);
        } else if (inGroupCall && pcMapRef.current.size > 0) {
          setRemoteStreams(prev => { const next = { ...prev }; delete next[leavingPeer]; return next; });
        } else {
          endCallRef.current(false);
        }
        break;
      }

      case "call_reject": {
        const rejectingPeer = String(data.user || "");
        if (callGroupIdRef.current && pcMapRef.current.size > 1) removePeerFromCall(rejectingPeer);
        else endCallRef.current(false, "rejected");
        break;
      }
    }
  }, [updateCallState, scrollBottom, updateActivity, notify, notifyCall, startRingtone, apiFetch, contactLabelFn, persistSeenIds, sendReadReceipt, removePeerFromCall]); // eslint-disable-line

  useEffect(() => { wsHandlerRef.current = wsHandler; }, [wsHandler]);
  useEffect(() => { initWSRef.current = initWS; }, [initWS]);

  // ── APP INIT ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          const res = await apiFetch<{ access_token: string; user: any }>("/auth/login", { method: "POST", body: JSON.stringify({ id_token: session.access_token }) });
          _finalizeAuth(res.access_token, res.user.email);
        }
      } catch { }
      finally { setIsMounted(true); (window as any).__FluxReady = true; }
    };
    initAuth();
    initOTAUpdater();
  }, [apiFetch]); // eslint-disable-line

  // ── NATIVE LIFECYCLE ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!IS_NATIVE) return;
    let appSub: any, notifSub: any;
    const pollInterval = setInterval(() => {
      if (isAppActiveRef.current && callStateRef.current === "idle") restoreCallOfferFromStorage();
    }, 5000);
    App.addListener("appStateChange", ({ isActive }) => {
      isAppActiveRef.current = isActive;
      if (isActive) {
        if (wsRef.current?.readyState !== WebSocket.OPEN) initWSRef.current?.();
        if (callStateRef.current === "idle") restoreCallOfferFromStorage();
      }
    }).then(sub => appSub = sub);
    LocalNotifications.addListener("localNotificationActionPerformed", action => {
      if (action.actionId === "ACCEPT_CALL") {
        setTimeout(() => acceptCallRef.current(), 300);
      } else if (action.actionId === "DECLINE_CALL") {
        setTimeout(() => rejectCallRef.current(), 100);
      } else {
        const chatId = action.notification?.extra?.chatId;
        if (chatId) {
          setTimeout(() => {
            openChatByChatIdRef.current(String(chatId));
          }, 300);
        }
      }
    }).then(sub => notifSub = sub);
    return () => { clearInterval(pollInterval); if (appSub) appSub.remove(); if (notifSub) notifSub.remove(); };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!IS_NATIVE) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.offerData) return;
      try {
        const offer = JSON.parse(detail.offerData);
        if (!offer.sdp || !offer.peer) return;
        pendingRemoteDescriptionRef.current = offer.sdp;
        callPeerRef.current = offer.peer; callPeerNameRef.current = offer.peerName || offer.peer;
        isVideoCallRef.current = !!offer.isVideo; callDirectionRef.current = "incoming";
        setCallPeer(offer.peer); setCallPeerName(offer.peerName || offer.peer);
        setIsVideoCall(!!offer.isVideo); updateCallState("incoming");
        try { sessionStorage.setItem("_Flux_call_offer", detail.offerData); } catch { }
        
        if (detail.action === "accept") {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            setTimeout(() => acceptCallRef.current(), 200);
          }
        } else {
          startRingtone();
        }
      } catch { return; }
    };
    const handleFluxMessage = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.chatId) return;
      setTimeout(() => {
        openChatByChatIdRef.current(String(detail.chatId));
      }, 300);
    };
    window.addEventListener("FluxCallAction", handler);
    window.addEventListener("FluxMessageAction", handleFluxMessage);
    return () => {
      window.removeEventListener("FluxCallAction", handler);
      window.removeEventListener("FluxMessageAction", handleFluxMessage);
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "NOTIFICATION_CLICK") {
        const chatId = event.data?.data?.chatId;
        if (chatId) {
          setTimeout(() => {
            openChatByChatIdRef.current(String(chatId));
          }, 300);
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", handleSwMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleSwMessage);
  }, []);

  useEffect(() => {
    if (token) {
      (async () => {
        await Promise.all([loadProfile(), loadContacts(), loadGroups()]);
        wsRetryDelay.current = 800; wsRetryCount.current = 0;
        initWS();
        _registerFCMToken(token);
        if (FluxNative) FluxNative.startService({ token, wsUrl: API }).catch(() => { });
      })();
    }
    return () => {
      if (wsPingInterval.current) clearInterval(wsPingInterval.current);
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    };
  }, [token]); // eslint-disable-line

  // ── DOWNLOAD MEDIA ────────────────────────────────────────────────────────────
  const handleDownloadMedia = async (url: string, filename?: string) => {
    const rawExt = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "jpg";
    const ext = ["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "mp3", "pdf", "doc", "docx"].includes(rawExt) ? rawExt : "jpg";
    const name = filename || `Flux_${Date.now()}.${ext}`;
    if (IS_NATIVE) {
      if (FluxNative && FluxNative.downloadFile) {
        try {
          showToast("Downloading file natively...", "info");
          await FluxNative.downloadFile({ url, name });
          showToast("Download started - check status bar", "success");
          return;
        } catch { }
      }
      try {
        showToast("Downloading…", "info");
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) throw new Error("Fetch failed");
        const blob = await res.blob();
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await Filesystem.writeFile({ path: name, data: base64, directory: Directory.Documents, recursive: true });
        showToast(`Saved to Documents: ${name}`, "success");
      } catch { showToast("Download failed — trying to open instead", "error"); window.open(url, "_blank"); }
      return;
    }
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error("Fetch failed");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: blobUrl, download: name });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch { window.open(url, "_blank"); }
  };

  // ── SEND MESSAGE ──────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (isUploadingAttachment) return;
    const text = inputMsg.trim();
    if (!text && pendingFiles.length === 0 && !pendingFile) return;
    if (!activeChat) return;

    if (pendingFiles.length > 0) {
      const filesToUpload = [...pendingFiles];
      setPendingFiles([]);
      setIsUploadingAttachment(true);
      try {
        for (let i = 0; i < filesToUpload.length; i++) {
          const item = filesToUpload[i];
          setMultiUploadProgress({ current: i + 1, total: filesToUpload.length });
          const form = new FormData();
          form.append("file", item.file);
          const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
          if (!res.ok) { showToast(`Failed to upload ${item.file.name}`, "error"); continue; }
          const data = await res.json();
          const tag = item.type === "image" ? `[IMAGE]${data.url}` : item.type === "audio" ? `[AUDIO]${data.url}` : item.type === "video" ? `[VIDEO]${data.url}` : item.type === "pdf" ? `[PDF]${data.url}` : `[FILE]${data.url}`;
          const { type: chatType, id } = activeChat;
          const tempId = `temp-${Date.now()}-${Math.random()}`;
          const optimisticMsg: Message = { id: tempId, user: currentUser, content: tag, timestamp: new Date().toISOString(), ...(chatType === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) };
          setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
          updateActivity(id, tag, optimisticMsg.timestamp);
          setTimeout(scrollBottom, 50);
          wsSend(JSON.stringify({ type: chatType === "user" ? "direct_message" : "group_message", content: tag, message_type: item.type, ...(chatType === "user" ? { target_user: id } : { group_id: id }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) }));
        }
      } catch { showToast("Upload failed due to network error", "error"); }
      finally { setIsUploadingAttachment(false); setMultiUploadProgress(null); setReplyingTo(null); }
      if (!text) return;
    }

    if (pendingFile) {
      const originalPendingFile = pendingFile;
      const { file, type } = pendingFile;
      setPendingFile(null);
      setIsUploadingAttachment(true);
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
        if (!res.ok) { showToast("Upload failed", "error"); setPendingFile(originalPendingFile); setIsUploadingAttachment(false); return; }
        const data = await res.json();
        const tag = type === "image" ? `[IMAGE]${data.url}` : type === "audio" ? `[AUDIO]${data.url}` : type === "video" ? `[VIDEO]${data.url}` : type === "pdf" ? `[PDF]${data.url}` : `[FILE]${data.url}`;
        const { type: chatType, id } = activeChat;
        const tempId = `temp-${Date.now()}-${Math.random()}`;
        const optimisticMsg: Message = { id: tempId, user: currentUser, content: tag, timestamp: new Date().toISOString(), ...(chatType === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) };
        setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
        updateActivity(id, tag, optimisticMsg.timestamp);
        setTimeout(scrollBottom, 50);
        wsSend(JSON.stringify({ type: chatType === "user" ? "direct_message" : "group_message", content: tag, message_type: type, ...(chatType === "user" ? { target_user: id } : { group_id: id }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) }));
        setReplyingTo(null);
      } catch { showToast("Upload failed due to network error", "error"); setPendingFile(originalPendingFile); setIsUploadingAttachment(false); return; }
      setIsUploadingAttachment(false);
      if (!text) return;
    }

    setInputMsg(""); setShowEmojis(false);
    const { type, id } = activeChat;
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    const optimisticMsg: Message = { id: tempId, user: currentUser, content: text, timestamp: new Date().toISOString(), ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) };
    setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
    updateActivity(id, text, optimisticMsg.timestamp);
    setTimeout(scrollBottom, 50);
    const failTimer = setTimeout(() => { setFailedMsgIds(prev => new Set(prev).add(tempId)); pendingTempTimers.current.delete(tempId); }, 60000);
    pendingTempTimers.current.set(tempId, failTimer);
    setReplyingTo(null);

    const basePayload = { type: type === "user" ? "direct_message" : "group_message", message_type: "text", ...(type === "user" ? { target_user: id } : { group_id: id }), ...(replyingTo ? { reply_to_id: replyingTo.id, reply_to_content: replyingTo.content } : {}) };
    (async () => {
      let contentToSend = text;
      try {
        if (type === "user" && e2ePrivKeyRef.current) {
          const theirPub = await getPeerPubKey(String(id));
          if (theirPub) contentToSend = await encryptDM(text, e2ePrivKeyRef.current, theirPub);
        } else if (type === "group" && e2ePrivKeyRef.current) {
          const groupKey = await getGroupKey(id);
          if (groupKey) contentToSend = await encryptGroupMsg(text, groupKey);
        }
      } catch { }
      wsSend(JSON.stringify({ ...basePayload, content: contentToSend }));
    })();
  };

  const sendSticker = useCallback(async (url: string) => {
    if (!activeChat) return;
    setShowStickers(false);
    const content = `[STICKER]${url}`;
    const { type, id } = activeChat;
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    const optimisticMsg: Message = { id: tempId, user: currentUser, content, timestamp: new Date().toISOString(), ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }) };
    setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
    updateActivity(id, content, optimisticMsg.timestamp);
    setTimeout(scrollBottom, 50);
    wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content, message_type: "sticker", ...(type === "user" ? { target_user: id } : { group_id: id }) }));
  }, [activeChat, currentUser, wsSend, updateActivity, scrollBottom]);

  const sendForward = useCallback(async (target: Chat) => {
    if (!forwardingMsg) return;
    const { type, id } = target;
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    const optimisticMsg: Message = { id: tempId, user: currentUser, content: forwardingMsg.content, timestamp: new Date().toISOString(), is_forwarded: true, forwarded_from_id: forwardingMsg.id, ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: target.name }) };
    if (activeChatRef.current && String(activeChatRef.current.id) === String(id)) {
      setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
      setTimeout(scrollBottom, 50);
    }
    updateActivity(id, forwardingMsg.content, optimisticMsg.timestamp);
    let contentToSend = forwardingMsg.content;
    try {
      if (type === "user" && e2ePrivKeyRef.current) {
        const theirPub = await getPeerPubKey(String(id));
        if (theirPub) contentToSend = await encryptDM(forwardingMsg.content, e2ePrivKeyRef.current, theirPub);
      } else if (type === "group" && e2ePrivKeyRef.current) {
        const groupKey = await getGroupKey(id);
        if (groupKey) contentToSend = await encryptGroupMsg(forwardingMsg.content, groupKey);
      }
    } catch { }
    wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: contentToSend, message_type: forwardingMsg.content.startsWith("[IMAGE]") ? "image" : forwardingMsg.content.startsWith("[AUDIO]") ? "audio" : forwardingMsg.content.startsWith("[VIDEO]") ? "video" : "text", is_forwarded: true, forwarded_from_id: forwardingMsg.id, ...(type === "user" ? { target_user: id } : { group_id: id }) }));
    setForwardingMsg(null); setShowForwardPicker(false);
    showToast("Message forwarded", "success");
  }, [forwardingMsg, currentUser, wsSend, updateActivity, scrollBottom, showToast, getPeerPubKey, getGroupKey]);

  const handleMultiForward = async () => {
    if (forwardingMsgs.length === 0 || forwardSelectedTargets.length === 0) return;
    const targets = [...forwardSelectedTargets];
    const msgs = [...forwardingMsgs];
    setForwardSelectedTargets([]);
    setShowForwardPicker(false);
    try {
      for (const target of targets) {
        const { type, id, name } = target;
        for (const msg of msgs) {
          const tempId = `temp-${Date.now()}-${Math.random()}`;
          const optimisticMsg: Message = { id: tempId, user: currentUser, content: msg.content, timestamp: new Date().toISOString(), is_forwarded: true, forwarded_from_id: msg.id, ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: name }) };
          if (activeChatRef.current && String(activeChatRef.current.id) === String(id)) {
            setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
            setTimeout(scrollBottom, 50);
          }
          updateActivity(id, msg.content, optimisticMsg.timestamp);
          let contentToSend = msg.content;
          try {
            if (type === "user" && e2ePrivKeyRef.current) {
              const theirPub = await getPeerPubKey(String(id));
              if (theirPub) contentToSend = await encryptDM(msg.content, e2ePrivKeyRef.current, theirPub);
            } else if (type === "group" && e2ePrivKeyRef.current) {
              const groupKey = await getGroupKey(id);
              if (groupKey) contentToSend = await encryptGroupMsg(msg.content, groupKey);
            }
          } catch { }
          wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: contentToSend, message_type: msg.content.startsWith("[IMAGE]") ? "image" : msg.content.startsWith("[AUDIO]") ? "audio" : msg.content.startsWith("[VIDEO]") ? "video" : "text", is_forwarded: true, forwarded_from_id: msg.id, ...(type === "user" ? { target_user: id } : { group_id: id }) }));
        }
      }
      showToast(`Forwarded to ${targets.length} chats`, "success");
    } catch { showToast("Forwarding failed", "error"); }
    finally { setForwardingMsgs([]); }
  };

  const toggleForwardTarget = (target: { type: "user" | "group"; id: string | number; name: string }) => {
    setForwardSelectedTargets(prev => {
      const exists = prev.some(t => String(t.id) === String(target.id));
      if (exists) return prev.filter(t => String(t.id) !== String(target.id));
      return [...prev, target];
    });
  };

  const retryMessage = useCallback(async (msg: Message) => {
    if (!activeChat) return;
    const tid = String(msg.id);
    setFailedMsgIds(prev => { const n = new Set(prev); n.delete(tid); return n; });
    const existing = pendingTempTimers.current.get(tid);
    if (existing) { clearTimeout(existing); pendingTempTimers.current.delete(tid); }
    const newTempId = `temp-${Date.now()}-${Math.random()}`;
    const newTemp: Message = { ...msg, id: newTempId, timestamp: new Date().toISOString() };
    setMessages(prev => { const next = prev.map(m => String(m.id) === tid ? newTemp : m); setMessagesCache(cache => ({ ...cache, [String(activeChat.id)]: next })); return next; });
    const failTimer = setTimeout(() => { setFailedMsgIds(prev => new Set(prev).add(newTempId)); pendingTempTimers.current.delete(newTempId); }, 30000);
    pendingTempTimers.current.set(newTempId, failTimer);
    const { type, id } = activeChat;
    (async () => {
      let contentToSend = msg.content;
      try {
        if (type === "user" && e2ePrivKeyRef.current) { const theirPub = await getPeerPubKey(String(id)); if (theirPub) contentToSend = await encryptDM(msg.content, e2ePrivKeyRef.current, theirPub); }
        else if (type === "group" && e2ePrivKeyRef.current) { const groupKey = await getGroupKey(id); if (groupKey) contentToSend = await encryptGroupMsg(msg.content, groupKey); }
      } catch { }
      wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", message_type: "text", content: contentToSend, ...(type === "user" ? { target_user: id } : { group_id: id }) }));
    })();
  }, [activeChat, wsSend, getPeerPubKey, getGroupKey]);

  const sendReaction = useCallback((msgId: string | number, emoji: string) => {
    if (!activeChat) return;
    setReactionPickerId(null); setSelectedMsgId(null);
    let previousEmoji: string | null = null;
    const msg = messages.find(m => String(m.id) === String(msgId));
    if (msg?.reactions) Object.entries(msg.reactions).forEach(([em, users]) => { if (users.includes(currentUser)) previousEmoji = em; });
    const commonPayload = activeChat.type === "user" ? { target_user: activeChat.id } : { group_id: activeChat.id };
    if (previousEmoji && previousEmoji !== emoji) wsSend(JSON.stringify({ type: "reaction", message_id: msgId, emoji: previousEmoji, ...commonPayload }));
    wsSend(JSON.stringify({ type: "reaction", message_id: msgId, emoji, ...commonPayload }));
    setMessages(prev => {
      const next = prev.map(m => String(m.id) === String(msgId) ? { ...m, reactions: updateReactionsForUser(m.reactions, currentUser, emoji) } : m);
      setMessagesCache(cache => ({ ...cache, [String(activeChat.id)]: next }));
      return next;
    });
  }, [activeChat, wsSend, currentUser, messages]);

  const saveEdit = async () => {
    if (!editingId || !activeChat) return;
    const { type, id } = activeChat;
    let contentToSend = editingText;
    try {
      if (type === "user" && e2ePrivKeyRef.current) { const theirPub = await getPeerPubKey(String(id)); if (theirPub) contentToSend = await encryptDM(editingText, e2ePrivKeyRef.current, theirPub); }
      else if (type === "group" && e2ePrivKeyRef.current) { const groupKey = await getGroupKey(id); if (groupKey) contentToSend = await encryptGroupMsg(editingText, groupKey); }
    } catch { }
    try {
      await apiFetch<void>(`/messages/${editingId}`, { method: "PATCH", body: JSON.stringify({ content: contentToSend }) });
      setMessages(prev => {
        const next = prev.map(m => m.id === editingId ? { ...m, content: editingText, edited_at: new Date().toISOString() } : m);
        setMessagesCache(cache => ({ ...cache, [String(activeChat.id)]: next }));
        return next;
      });
      setEditingId(null); setEditingText("");
    } catch { }
  };

  const deleteMsg = async (id: string | number) => {
    if (String(id).startsWith("temp-")) {
      const tid = String(id);
      const t = pendingTempTimers.current.get(tid);
      if (t) { clearTimeout(t); pendingTempTimers.current.delete(tid); }
      setFailedMsgIds(prev => { const n = new Set(prev); n.delete(tid); return n; });
      setMessages(prev => { const next = prev.filter(m => String(m.id) !== tid); setMessagesCache(cache => ({ ...cache, [String(activeChat?.id || "")]: next })); return next; });
      return;
    }
    try {
      await apiFetch<void>(`/messages/${id}`, { method: "DELETE" });
      setMessages(prev => { const next = prev.map(m => m.id === id ? { ...m, is_deleted: true } : m); setMessagesCache(cache => ({ ...cache, [String(activeChat?.id || "")]: next })); return next; });
      setDeletedMsgIds(prev => {
        const next = new Set(prev);
        next.add(String(id));
        if (currentUserRef.current) localStorage.setItem(`deleted_msgs_${currentUserRef.current}`, JSON.stringify([...next]));
        deletedMsgIdsRef.current = next;
        return next;
      });
    } catch { }
  };

  const sendTypingEvent = useDebounceCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && activeChatRef.current?.type === "user") wsRef.current.send(JSON.stringify({ type: "typing", target_user: activeChatRef.current.id }));
  }, 300);
  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => { setInputMsg(e.target.value); sendTypingEvent(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeChat) return;
    const newPending: typeof pendingFiles = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const type = file.type.startsWith("image") ? "image" : file.type.startsWith("audio") ? "audio" : file.type.startsWith("video") ? "video" : file.type === "application/pdf" ? "pdf" : "file";
      newPending.push({ file, url, type, caption: "" });
    }
    setPendingFiles(prev => [...prev, ...newPending]);
    e.target.value = "";
  };

  const getMediaStream = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new Error("Camera/microphone not available.");
    try { return await md.getUserMedia(constraints); }
    catch (err: any) {
      const name: string = err?.name || "";
      if ((name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") && constraints.video && typeof constraints.video === "object") return md.getUserMedia({ audio: constraints.audio, video: true });
      if (name === "NotAllowedError" || name === "PermissionDeniedError") throw new Error("Permission denied. Please allow camera/microphone access.");
      if (name === "NotFoundError" || name === "DevicesNotFoundError") throw new Error("No camera/microphone found.");
      if (name === "NotReadableError" || name === "TrackStartError") throw new Error("Device already in use.");
      throw err;
    }
  };

  const toggleRecording = async () => {
    if (!activeChat) return;
    if (isRecording) { mediaRecorderRef.current?.stop(); setIsRecording(false); mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop()); return; }
    try {
      const stream = await getMediaStream({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = e => audioChunksRef.current.push(e.data);
      mr.onstart = () => {
        setRecordingDuration(0);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = setInterval(() => setRecordingDuration(prev => prev + 1), 1000);
      };
      mr.onstop = async () => {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        if (cancelRecordingRef.current) { cancelRecordingRef.current = false; return; }
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("file", blob, "voice.webm");
        try {
          const res = await fetch(`${API}/upload`, { method: "POST", headers: { Authorization: `Bearer ${tokenRef.current}` }, body: form });
          if (!res.ok) throw new Error("Upload failed");
          const data = await res.json();
          const tag = `[AUDIO]${data.url}`;
          const { type, id } = activeChat;
          const optimisticMsg: Message = { id: `temp-${Date.now()}-${Math.random()}`, user: currentUser, content: tag, timestamp: new Date().toISOString(), ...(type === "user" ? { target_user: String(id) } : { group_id: id, group_name: activeChat.name }) };
          setMessages(prev => { const next = [...prev, optimisticMsg]; setMessagesCache(cache => ({ ...cache, [String(id)]: next })); return next; });
          setTimeout(scrollBottom, 50);
          wsSend(JSON.stringify({ type: type === "user" ? "direct_message" : "group_message", content: tag, message_type: "audio", ...(type === "user" ? { target_user: id } : { group_id: id }) }));
        } catch { showToast("Voice recording upload failed", "error"); }
      };
      mr.start(); setIsRecording(true);
    } catch (err: any) { showToast(`Microphone error: ${err?.message || err}`, "error"); setIsRecording(false); }
  };

  // ── WEBRTC ────────────────────────────────────────────────────────────────────
  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
      { urls: "turn:a.relay.metered.ca:80", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" },
      { urls: "turn:a.relay.metered.ca:80?transport=tcp", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" },
      { urls: "turn:a.relay.metered.ca:443", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" },
      { urls: "turns:a.relay.metered.ca:443?transport=tcp", username: "e8dd65b92f3adf4536ee4310", credential: "6aBk4SYRGqDHpFKf" },
    ],
    iceCandidatePoolSize: 10,
  };

  const setupWebRTC = async (targetEmail: string) => {
    const localStream = localStreamRef.current;
    if (!localStream) throw new Error("Local media stream unavailable");
    const pc = new RTCPeerConnection(rtcConfig);
    pcMapRef.current.set(targetEmail, pc);
    peerConnectionRef.current = pc;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = event => {
      setRemoteStreams(prev => {
        const stream = (event.streams?.[0]) || (() => { const s = prev[targetEmail] || new MediaStream(); if (!s.getTracks().find(t => t.id === event.track.id)) s.addTrack(event.track); return s; })();
        if (targetEmail === callPeerRef.current) {
          remoteStreamRef.current = stream;
          const videoEl = remoteVideoRef.current;
          if (videoEl && videoEl.srcObject !== stream) { videoEl.srcObject = stream; videoEl.volume = 1.0; videoEl.play().catch(() => { }); }
          const audioEl = remoteAudioRef.current;
          if (audioEl && audioEl.srcObject !== stream) { audioEl.srcObject = stream; audioEl.volume = 1.0; audioEl.play().catch(() => { }); }
        }
        return { ...prev, [targetEmail]: stream };
      });
      if (IS_NATIVE && FluxNative) (FluxNative as any).startCallAudio().catch(() => { });
      applyAudioOutput(isSpeaker);
    };

    pc.onicecandidate = event => {
      if (event.candidate) {
        wsSend(JSON.stringify({ type: "ice_candidate", target_user: targetEmail, candidate: event.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "failed") { if (pc.restartIce) pc.restartIce(); else endCall(true, "missed"); }
      if (s === "disconnected") setTimeout(() => { if (pc.iceConnectionState === "disconnected") endCall(true, "missed"); }, 5000);
    };

    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") endCall(true, "missed"); };
    return pc;
  };

  const startCall = async (video = true) => {
    if (!activeChat) return;
    const isGroup = activeChat.type === "group";
    const groupId = isGroup ? activeChat.id : null;
    if (groupId) callGroupIdRef.current = groupId;
    const targetIds = isGroup ? groups.find(g => g.id === activeChat.id)?.members.map(getEmail).filter(m => m !== currentUser) || [] : [String(activeChat.id)];
    if (!targetIds.length) return;
    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
      iceCandidateQueueRef.current = [];
      setIsVideoCall(video); isVideoCallRef.current = video; setIsVideoSwapped(false);
      updateCallState("calling"); setCallPeer(targetIds[0]);
      callPeerRef.current = targetIds[0];
      const c = contacts.find(c => c.email === targetIds[0]);
      const peerName = c ? contactLabelFn(c) : activeChat.name;
      setCallPeerName(peerName);
      callPeerNameRef.current = peerName;
      callDirectionRef.current = "outgoing";
      localStreamRef.current = await getMediaStream({ audio: true, video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false });
      if (localVideoRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      for (const target of targetIds) {
        const pc = await setupWebRTC(target);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const wrappedSdp = { type: offer.type, sdp: offer.sdp, ...(groupId ? { group_id: groupId } : {}), sender_name: profile.displayName || profile.username || currentUser };
        wsSend(JSON.stringify({ type: "call_offer", target_user: target, sdp: wrappedSdp, isVideo: video, sender_name: profile.displayName || profile.username || currentUser, ...(groupId ? { group_id: groupId } : {}) }));
      }
    } catch (err: any) { showToast(`Could not start call: ${err.message || err}`, "error"); endCall(false); }
  };

  const acceptCall = async () => {
    if (acceptInProgressRef.current) return;
    acceptInProgressRef.current = true;
    stopRingtone(); cancelCallNotification();
    if (FluxNative) FluxNative.stopCall().catch(() => { });
    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
      const needVideo = isVideoCallRef.current;
      setIsVideoSwapped(false);
      if (!pendingRemoteDescriptionRef.current) {
        try {
          const stored = sessionStorage.getItem("_Flux_call_offer");
          if (stored) {
            const parsed: StoredCallOffer = JSON.parse(stored);
            const sdpObj = (parsed.sdp && typeof parsed.sdp === "object") ? parsed.sdp as any : {};
            const offerGroupId = parsed.group_id || sdpObj.group_id;
            if (offerGroupId) callGroupIdRef.current = offerGroupId;
            const realSdp = sdpObj.sdp ? { type: sdpObj.type, sdp: sdpObj.sdp } : parsed.sdp;
            pendingRemoteDescriptionRef.current = realSdp;
            if (!callPeerRef.current && parsed.peer) {
              callPeerRef.current = parsed.peer; callPeerNameRef.current = parsed.peerName;
              isVideoCallRef.current = parsed.isVideo; callDirectionRef.current = "incoming";
              setCallPeer(parsed.peer); setCallPeerName(parsed.peerName); setIsVideoCall(parsed.isVideo);
            }
          }
        } catch { }
      }
      try { sessionStorage.removeItem("_Flux_call_offer"); } catch { }
      const targetPeer = callPeerRef.current || callPeer || null;
      if (!targetPeer || !pendingRemoteDescriptionRef.current) { endCall(false, "missed"); return; }
      if (IS_NATIVE && FluxNative) await (FluxNative as any).startCallAudio().catch(() => { });
      localStreamRef.current = await getMediaStream({ audio: true, video: needVideo ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false });
      if (localVideoRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      const pc = await setupWebRTC(targetPeer);
      await pc.setRemoteDescription(new RTCSessionDescription(pendingRemoteDescriptionRef.current));
      const queue = iceQueuesRef.current.get(targetPeer) || [];
      while (queue.length > 0) { const c = queue.shift(); if (c) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); }
      iceQueuesRef.current.set(targetPeer, queue);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const payload = JSON.stringify({ type: "call_answer", target_user: targetPeer, sdp: answer });
      wsSend(payload);
      updateCallState("connected"); callStartTimeRef.current = Date.now();

      const meshGroupId = callGroupIdRef.current;
      if (meshGroupId) {
        const group = groupsRef.current.find(g => String(g.id) === String(meshGroupId));
        if (group) {
          const otherMembers = group.members.map(getEmail).filter(m => m !== currentUser && m !== targetPeer && !pendingMeshOffersRef.current.has(m) && m > currentUser);
          for (const meshPeer of otherMembers) {
            if (!pcMapRef.current.has(meshPeer)) {
              try {
                const meshPc = await setupWebRTC(meshPeer);
                const meshOffer = await meshPc.createOffer();
                await meshPc.setLocalDescription(meshOffer);
                wsSend(JSON.stringify({ type: "call_offer", target_user: meshPeer, sdp: { type: meshOffer.type, sdp: meshOffer.sdp, is_mesh: true, group_id: meshGroupId, sender_name: profile.displayName || profile.username || currentUser }, isVideo: needVideo, is_mesh: true, group_id: meshGroupId }));
              } catch { }
            }
          }
        }
      }

      const queuedOffers = Array.from(pendingMeshOffersRef.current.entries());
      pendingMeshOffersRef.current.clear();
      for (const [meshPeer, sdp] of queuedOffers) {
        if (!pcMapRef.current.has(meshPeer)) {
          try {
            const meshPc = await setupWebRTC(meshPeer);
            await meshPc.setRemoteDescription(new RTCSessionDescription(sdp));
            const q = iceQueuesRef.current.get(meshPeer) || [];
            while (q.length > 0) { const c = q.shift(); if (c) await meshPc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error); }
            iceQueuesRef.current.set(meshPeer, q);
            const meshAnswer = await meshPc.createAnswer();
            await meshPc.setLocalDescription(meshAnswer);
            wsSend(JSON.stringify({ type: "call_answer", target_user: meshPeer, sdp: meshAnswer }));
          } catch { }
        }
      }

      setTimeout(() => {
        if (remoteStreamRef.current) {
          const videoEl = remoteVideoRef.current;
          if (videoEl && videoEl.srcObject !== remoteStreamRef.current) { videoEl.srcObject = remoteStreamRef.current; videoEl.volume = 1.0; videoEl.play().catch(() => { }); }
          applyAudioOutput(isSpeaker);
        }
      }, 300);

      const retryGroupId = callGroupIdRef.current;
      if (retryGroupId) {
        setTimeout(async () => {
          if (callStateRef.current !== "connected") return;
          const retryGroup = groupsRef.current.find(g => String(g.id) === String(retryGroupId));
          if (!retryGroup) return;
          const me = currentUserRef.current;
          const target = callPeerRef.current;
          const missingPeers = retryGroup.members.map(getEmail).filter(m => m !== me && m !== target && (!pcMapRef.current.has(m) || ["failed", "disconnected"].includes(pcMapRef.current.get(m)?.iceConnectionState || "")) && m > me);
          for (const meshPeer of missingPeers) {
            if (!localStreamRef.current) break;
            try {
              const old = pcMapRef.current.get(meshPeer);
              if (old) { old.close(); pcMapRef.current.delete(meshPeer); }
              const retryPc = await setupWebRTC(meshPeer);
              const retryOffer = await retryPc.createOffer();
              await retryPc.setLocalDescription(retryOffer);
              wsSend(JSON.stringify({ type: "call_offer", target_user: meshPeer, sdp: { type: retryOffer.type, sdp: retryOffer.sdp, is_mesh: true, group_id: retryGroupId, sender_name: profile.displayName || profile.username || me }, isVideo: isVideoCallRef.current, is_mesh: true, group_id: retryGroupId }));
            } catch { }
          }
        }, 4000);
      }
    } catch { endCall(false, "missed"); }
    finally { acceptInProgressRef.current = false; }
  };

  const rejectCall = () => {
    stopRingtone(); cancelCallNotification();
    try { sessionStorage.removeItem("_Flux_call_offer"); } catch { }
    if (callPeer) wsSend(JSON.stringify({ type: "call_reject", target_user: callPeer }));
    pcMapRef.current.forEach((_, peerEmail) => { if (peerEmail !== callPeer) wsSend(JSON.stringify({ type: "call_end", target_user: peerEmail })); });
    endCall(false, "rejected");
  };

  useEffect(() => { acceptCallRef.current = acceptCall; }, [acceptCall]);
  useEffect(() => { rejectCallRef.current = rejectCall; }, [rejectCall]);

  const toggleMute = () => {
    if (localStreamRef.current) { localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = isMuted)); setIsMuted(!isMuted); }
  };

  const toggleSpeaker = () => {
    const s = !isSpeaker;
    setIsSpeaker(s);
    if (IS_NATIVE && FluxNative) (FluxNative as any).setAudioMode({ speaker: s }).catch(() => { });
    else applyAudioOutput(s);
  };

  const switchCamera = async () => {
    if (!isVideoCall || !localStreamRef.current) return;
    const newMode = facingMode === "user" ? "environment" : "user";
    try {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      let ns: MediaStream;
      try { ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: { exact: newMode } } }); }
      catch { ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
      localStreamRef.current = ns;
      if (isMuted) ns.getAudioTracks().forEach(t => (t.enabled = false));
      if (localVideoRef.current) { localVideoRef.current.srcObject = ns; localVideoRef.current.play().catch(() => { }); }
      const [at] = ns.getAudioTracks();
      const [vt] = ns.getVideoTracks();
      pcMapRef.current.forEach(pc => pc.getSenders().forEach(sender => {
        if (sender.track?.kind === "audio" && at) sender.replaceTrack(at);
        if (sender.track?.kind === "video" && vt) sender.replaceTrack(vt);
      }));
      setFacingMode(newMode);
    } catch { }
  };

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (callState === "connected") interval = setInterval(() => setCallDuration(Math.floor((Date.now() - (callStartTimeRef.current || Date.now())) / 1000)), 1000);
    else setCallDuration(0);
    return () => clearInterval(interval);
  }, [callState]);

  useEffect(() => {
    if (callState === "idle") return;
    const attach = () => {
      if (localStreamRef.current && localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current) { localVideoRef.current.srcObject = localStreamRef.current; localVideoRef.current.play().catch(() => { }); }
      if (remoteStreamRef.current && remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) { remoteVideoRef.current.srcObject = remoteStreamRef.current; remoteVideoRef.current.play().catch(() => { }); }
      if (!isVideoCallRef.current && remoteAudioRef.current && remoteStreamRef.current && remoteAudioRef.current.srcObject !== remoteStreamRef.current) { remoteAudioRef.current.srcObject = remoteStreamRef.current; remoteAudioRef.current.play().catch(() => { }); applyAudioOutput(isSpeaker); }
    };
    attach();
    const t1 = setTimeout(attach, 200), t2 = setTimeout(attach, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [callState, isVideoCall, remoteStreams, isSpeaker, applyAudioOutput]);

  // ── PIP DRAG ──────────────────────────────────────────────────────────────────
  const onPipMouseDown = (e: React.MouseEvent) => { pipDragging.current = true; pipDragStart.current = { mx: e.clientX, my: e.clientY, x: pipPos.x, y: pipPos.y }; e.preventDefault(); };
  const onPipTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; pipDragging.current = true; pipDragStart.current = { mx: t.clientX, my: t.clientY, x: pipPos.x, y: pipPos.y }; };
  const onPipMouseMove = useCallback((e: MouseEvent) => { if (!pipDragging.current) return; setPipPos({ x: pipDragStart.current.x + e.clientX - pipDragStart.current.mx, y: pipDragStart.current.y + e.clientY - pipDragStart.current.my }); }, []);
  const onPipTouchMove = useCallback((e: TouchEvent) => { if (!pipDragging.current) return; const t = e.touches[0]; setPipPos({ x: pipDragStart.current.x + t.clientX - pipDragStart.current.mx, y: pipDragStart.current.y + t.clientY - pipDragStart.current.my }); }, []);
  const onPipDragEnd = useCallback(() => { pipDragging.current = false; }, []);

  useEffect(() => {
    if (callState !== "idle" && isVideoCall) {
      window.addEventListener("mousemove", onPipMouseMove);
      window.addEventListener("mouseup", onPipDragEnd);
      window.addEventListener("touchmove", onPipTouchMove, { passive: true });
      window.addEventListener("touchend", onPipDragEnd);
      return () => {
        window.removeEventListener("mousemove", onPipMouseMove);
        window.removeEventListener("mouseup", onPipDragEnd);
        window.removeEventListener("touchmove", onPipTouchMove);
        window.removeEventListener("touchend", onPipDragEnd);
      };
    }
  }, [callState, isVideoCall, onPipMouseMove, onPipTouchMove, onPipDragEnd]);

  // ── DERIVED / MEMOS ───────────────────────────────────────────────────────────
  const isTyping = useMemo(() => activeChat?.type === "user" && typingSet.has(String(activeChat.id)), [activeChat, typingSet]);

  const sortedChats = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const contactList = (q ? contacts.filter(c => contactLabel(c).toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q)) : contacts)
      .map(c => ({ type: "user" as const, id: c.email, item: c, lastActivityTs: lastActivity[c.email] || 0 }));
    const groupList = (q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups)
      .map(g => ({ type: "group" as const, id: String(g.id), item: g, lastActivityTs: lastActivity[String(g.id)] || 0 }));
    return [...contactList, ...groupList].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }, [contacts, groups, searchQuery, lastActivity, contactLabel]);

  const searchMessageResults = useMemo(() => {
    if (!searchQuery) return [];
    const results: (Message & { chatId: string | number; chatType: "user" | "group" })[] = [];
    Object.entries(messagesCache).forEach(([chatId, msgs]) => {
      const isGroup = groups.some(g => String(g.id) === chatId);
      msgs.forEach(m => { if (!m._callRecord && m.content.toLowerCase().includes(searchQuery.toLowerCase()) && !m.content.startsWith("[")) results.push({ ...m, chatId, chatType: isGroup ? "group" : "user" }); });
    });
    return results;
  }, [searchQuery, groups, messagesCache]);

  const mergedMessages = useMemo(() => {
    if (!activeChat || activeChat.type !== "user") return messages;
    const chatId = String(activeChat.id);
    const relevantCallLogs = callLogs.filter(log => String(log.peer) === chatId);
    if (relevantCallLogs.length === 0) return messages;
    const virtualCalls = relevantCallLogs.map(log => {
      const icon = log.media === "video" ? "📹" : "📞";
      const label = log.media === "video" ? "Video call" : "Voice call";
      const status = log.status === "completed" ? ` · ${fmtDuration(log.duration)}` : log.status === "rejected" ? " · Declined" : " · Missed";
      return { id: `call-${log.id}`, user: log.direction === "outgoing" ? (currentUser || "") : log.peer, content: `${icon} ${log.direction === "incoming" ? "Incoming" : "Outgoing"} ${label}${status}`, timestamp: log.timestamp, _callRecord: true } as Message;
    });
    const combined = [...messages];
    virtualCalls.forEach(vc => { if (!combined.some(m => m.id === vc.id || (m._callRecord && Math.abs(parseTs(m.timestamp).getTime() - parseTs(vc.timestamp).getTime()) < 5000))) combined.push(vc); });
    return combined.sort((a, b) => parseTs(a.timestamp).getTime() - parseTs(b.timestamp).getTime());
  }, [messages, callLogs, activeChat, currentUser]);

  const formatDate = (ts: string) => {
    const d = parseTs(ts), today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const groupedMessages = useMemo(() => {
    const out: GroupedMessage[] = [];
    let lastDate: string | null = null;
    for (const msg of mergedMessages) {
      const label = formatDate(msg.timestamp);
      if (label !== lastDate) { out.push({ type: "divider", label }); lastDate = label; }
      out.push({ type: "msg", ...msg });
    }
    return out;
  }, [mergedMessages]); // eslint-disable-line

  const rowVirtualizer = useVirtualizer({
    count: groupedMessages.length,
    getScrollElement: () => msgListRef.current,
    estimateSize: () => 60,
    overscan: 10,
    gap: 2,
    getItemKey: useCallback((index: number) => {
      const item = groupedMessages[index];
      return item ? (item.type === "divider" ? `div-${item.label}-${index}` : item.id) : index;
    }, [groupedMessages]),
  });
  rowVirtualizerRef.current = rowVirtualizer;
  groupedMessagesRef.current = groupedMessages;

  const handleAppClick = useCallback(() => { setSidebarDeleteId(null); setReactionPickerId(null); setSelectedMsgId(null); setShowMuteMenu(false); setShowStickers(false); }, []);
  const checkUsernameAvailability = useDebounceCallback(async (value: string) => {
    if (value.length >= 3) { try { const res = await apiFetch<{ available: boolean }>(`/auth/check-username/${value}`); if (!res.available) dispatchAuth({ type: "SET_ERROR", value: "Username already taken" }); } catch { } }
  }, 500);

  // ── EMOJI DATA ────────────────────────────────────────────────────────────────
  const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🫢", "🤫", "🤔", "🫡", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁", "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "💀", "👻", "😈", "👿", "💩", "🤡", "👹", "👍", "👎", "👌", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "👋", "🤏", "👏", "🙌", "🫶", "🤲", "🙏", "✍️", "💪", "❤️", "🧡", "💛", "💚", "💙", "💜", "🔥", "💫", "⭐", "🌟", "✨", "💥", "❄️", "🌈", "☀️", "🌙", "🎉", "🎊", "🎈", "🎁", "🏆", "🥇", "🎵", "🎶", "🎤", "🎸", "🎹", "🚀", "✈️", "🌍", "🌊", "🌺", "🌸", "🍕", "🍔", "☕", "✅", "❌", "⚡", "💯", "💬", "📌", "🔗", "🔑", "💡", "🔔", "📢", "👀", "💤", "🆗", "🆙", "🔝"];
  const reactionEmojis = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "💯"];

  const emojiRows = useMemo(() => {
    const COLS = 10, rows = [];
    for (let i = 0; i < emojis.length; i += COLS) rows.push(emojis.slice(i, i + COLS));
    return rows;
  }, [emojis]);

  useEffect(() => { if (showEmojis && emojiActiveCellRef.current) emojiActiveCellRef.current.focus(); }, [focusedEmojiCoord, showEmojis]);

  const prevShowEmojis = useRef(showEmojis);
  useEffect(() => {
    if (showEmojis) setFocusedEmojiCoord({ r: 0, c: 0 });
    else if (prevShowEmojis.current && !showEmojis) emojiToggleRef.current?.focus();
    prevShowEmojis.current = showEmojis;
  }, [showEmojis]);

  const handleEmojiKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, r: number, c: number) => {
    let nextR = r, nextC = c;
    const rowCount = emojiRows.length;
    const colCount = emojiRows[r].length;
    let handled = true;
    switch (e.key) {
      case "ArrowRight": if (c < colCount - 1) nextC = c + 1; else if (r < rowCount - 1) { nextR = r + 1; nextC = 0; } break;
      case "ArrowLeft": if (c > 0) nextC = c - 1; else if (r > 0) { nextR = r - 1; nextC = emojiRows[r - 1].length - 1; } break;
      case "ArrowDown": if (r < rowCount - 1) { nextR = r + 1; nextC = Math.min(c, emojiRows[r + 1].length - 1); } break;
      case "ArrowUp": if (r > 0) { nextR = r - 1; nextC = Math.min(c, emojiRows[r - 1].length - 1); } break;
      case "Home": nextC = 0; break;
      case "End": nextC = colCount - 1; break;
      case "Escape": setShowEmojis(false); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); setFocusedEmojiCoord({ r: nextR, c: nextC }); }
  };

  const callDisplayName = callPeerName || (callPeer ? getPeerName(callPeer) : "") || (callPeer ? callPeer.split("@")[0] : "");

  if (!isMounted) return <div className="app loading-screen"><div className="spinner loading-spinner-circle" /></div>;

  // ─── RENDER HELPERS (inline to avoid passing too many props) ──────────────────
  const renderPeerVideoOrAvatar = (peerId: string, stream: MediaStream | null, idx?: number, total?: number) => {
    const isPeerCamOff = cameraStates[peerId] === true;
    const peerContact = contacts.find(c => c.email === peerId);
    const peerAvatar = peerContact?.avatar_url;
    const peerLabel = getPeerName(peerId);
    const peerInitial = peerLabel === "Unknown User" ? peerId.split("@")[0] : peerLabel;
    return (
      <div style={{ position: "relative", width: "100%", height: total && total > 1 ? `${Math.floor(100 / total)}%` : "100%", flexShrink: 0, borderBottom: (idx !== undefined && total !== undefined && idx < total - 1) ? "1.5px solid rgba(255,255,255,0.15)" : "none", overflow: "hidden" }}>
        {isPeerCamOff || !stream ? (
          <div style={{ width: "100%", height: "100%", background: "#1a1a1a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: "#fff", fontWeight: 700, overflow: "hidden", border: "2px solid rgba(255,255,255,0.15)" }}>
              {peerAvatar ? <img src={peerAvatar} alt={peerLabel} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : peerInitial[0]?.toUpperCase() || "?"}
            </div>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{isPeerCamOff ? "Camera Off" : ""}</span>
          </div>
        ) : (
          <video autoPlay playsInline ref={node => { if (node && node.srcObject !== stream) { node.srcObject = stream; node.play().catch(() => { }); } }} style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }} />
        )}
        <div style={{ position: "absolute", bottom: 12, left: 12, background: "rgba(0,0,0,0.65)", color: "#fff", padding: "6px 12px", borderRadius: 16, fontSize: 13, fontWeight: 500, backdropFilter: "blur(4px)", pointerEvents: "none", zIndex: 5, border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: isPeerCamOff ? "#94a3b8" : "#4ade80", boxShadow: isPeerCamOff ? "none" : "0 0 8px #4ade80" }} />{peerInitial}
        </div>
      </div>
    );
  };

  const chat = activeChat;

  // ─── JSX ─────────────────────────────────────────────────────────────────────
  return (
    <div className="app" onClick={handleAppClick}>

      {/* ── PROFILE OVERLAYS ── */}
      {showContactProfile && activeChat?.type === "user" && (
        <ContactProfile
          contact={contacts.find(c => c.email === activeChat.id)}
          activeChat={activeChat} currentUser={currentUser} nicknames={nicknames}
          contactLabel={contactLabel} callLogs={callLogs} messagesCache={messagesCache}
          onClose={() => { setShowContactProfile(false); if (openedProfileFromSidebar) { setActiveChat(null); setOpenedProfileFromSidebar(false); } }}
          onCall={video => { setShowContactProfile(false); setOpenedProfileFromSidebar(false); startCall(video); }}
          onNicknameEdit={() => { setShowContactProfile(false); setOpenedProfileFromSidebar(false); openHeaderNicknameEdit(); }}
          getPeerName={getPeerName} onViewFile={(url, type) => setViewFile({ url, type })}
          isBlocked={blockedUsers.has(String(activeChat.id))}
          onBlock={() => blockUser(String(activeChat.id))}
          onUnblock={() => unblockUser(String(activeChat.id))}
        />
      )}

      {showGroupProfile && activeChat?.type === "group" && (
        <GroupProfile
          group={groups.find(g => g.id === activeChat.id)} activeChat={activeChat}
          currentUser={currentUser} contacts={contacts} contactLabel={contactLabel}
          callLogs={callLogs} messagesCache={messagesCache}
          isUploadingGroupAvatar={isUploadingGroupAvatar} groupAvatarInputRef={groupAvatarInputRef}
          handleGroupAvatarUpload={handleGroupAvatarUpload}
          onClose={() => { setShowGroupProfile(false); if (openedProfileFromSidebar) { setActiveChat(null); setOpenedProfileFromSidebar(false); } }}
          onCall={video => { setShowGroupProfile(false); setOpenedProfileFromSidebar(false); startCall(video); }}
          onAddMember={addGroupMember} onViewFile={(url, type) => setViewFile({ url, type })}
          getPeerName={getPeerName} profile={profile} apiFetch={apiFetch}
          setGroups={setGroups}
          showToast={showToast}
          loadGroups={loadGroups}
        />
      )}

      {messageInfoMsg && (
        <MessageInfoModal
          message={messageInfoMsg}
          group={groups.find(g => String(g.id) === String(activeChat?.id))}
          contacts={contacts} currentUser={currentUser} getPeerName={getPeerName}
          onClose={() => setMessageInfoMsg(null)}
        />
      )}

      {/* ══ AUTH SCREEN ══════════════════════════════════════════════════════════ */}
      {!isAuth ? (
              </>)}

              {auth.step === "forgot-password" && (<>
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })} className="ac-back">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg> Back
                </button>
                <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🔑</div>
                <h2 className="ac-title">Reset password</h2>
                <p className="ac-sub">Enter your email and we'll send you a reset link.</p>
                <div className="ac-field">
                  <label>Email</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></svg>
                    <input value={auth.email} onChange={e => dispatchAuth({ type: "SET_FIELD", field: "email", value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleForgotPassword()} type="email" placeholder="you@example.com" className="ac-input" />
                  </div>
                </div>
                <button disabled={auth.loading} onClick={handleForgotPassword} className="ac-btn">
                  {auth.loading && <span className="spinner" />}
                  {auth.loading ? "Sending…" : "Send reset link"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {auth.step === "reset-password" && (<>
                <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🔒</div>
                <h2 className="ac-title">Set new password</h2>
                <p className="ac-sub">Choose a strong new password for your account.</p>
                {[
                  { label: "New password", field: "pass" as const, placeholder: "At least 6 characters" },
                  { label: "Confirm new password", field: "pass2" as const, placeholder: "••••••••" },
                ].map(({ label, field, placeholder }) => (
                  <div key={field} className="ac-field">
                    <label>{label}</label>
                    <div className="ac-input-wrap">
                      <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                      <input value={auth[field]} onChange={e => dispatchAuth({ type: "SET_FIELD", field, value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleResetPassword()} type="password" placeholder={placeholder} className="ac-input" />
                    </div>
                  </div>
                ))}
                <button disabled={auth.loading} onClick={handleResetPassword} className="ac-btn">
                  {auth.loading && <span className="spinner" />}
                  {auth.loading ? "Updating…" : "Set new password"}
                  {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
                </button>
              </>)}

              {auth.error && (
                <div className="ac-error">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                  {auth.error}
                </div>
              )}
            </div>
          </div>
        </div >

      ) : (
        /* ══ MAIN APP SHELL ══════════════════════════════════════════════════ */
        <div className={`shell ${activeChat ? "chat-active" : ""}`}>

          {wsStatus === "offline" && (
            <div className="offline-banner">
              <div className="offline-banner-content">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                  <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.5M5 12.5a10.94 10.94 0 015.83-2.84M8.53 16.03a6 6 0 013.47-1.53M12 20h.01M16.24 7.76a16.14 16.14 0 012.01 1.24" />
                </svg>
                You are currently offline. Check your connection.
              </div>
              <button className="offline-retry-btn" onClick={() => {
                wsRetryDelay.current = 800;
                wsRetryCount.current = 0;
                setWsStatus("reconnecting");
                initWSRef.current?.();
              }}>
                Retry Connection
              </button>
            </div>
          )}

          {/* ── SIDEBAR ───────────────────────────────────────────────────────── */}
          <aside className="sidebar">
            <div className="sb-brand-header">
              <div className="sb-brand-left">
                <div className="sb-brand-icon-wrap" style={{ overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <img src="/icon.png" alt="Flux" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
                <span className="sb-brand-name">Flux</span>
                <span
                  className="sb-ws-dot"
                  style={{
                    background: wsStatus === "connected" ? "#4ade80" : wsStatus === "reconnecting" ? "#fbbf24" : wsStatus === "offline" ? "#ef4444" : "#333",
                    cursor: wsStatus !== "connected" ? "pointer" : "default",
                  }}
                  title={
                    wsStatus === "connected" ? "Connected"
                      : wsStatus === "reconnecting" ? "Reconnecting..."
                        : wsStatus === "offline" ? "Connection lost. Click to retry."
                          : "Disconnected. Click to reconnect."
                  }
                  onClick={() => {
                    if (wsStatus !== "connected" && wsStatus !== "reconnecting") {
                      wsRetryDelay.current = 800;
                      wsRetryCount.current = 0;
                      setWsStatus("reconnecting");
                      initWSRef.current?.();
                    }
                  }}
                />
                {totalUnread > 0 && (
                  <span onClick={e => { e.stopPropagation(); markAllRead(); }} title="Mark all read" className="sb-total-unread">
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
              </div>
              <div className="sb-brand-actions">
                <button className="sb-icon-btn" title="Call History" onClick={e => { e.stopPropagation(); setShowCallLogUI(true); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                </button>
                <button className={`sb-icon-btn ${showMyProfileSettings ? "sb-icon-btn--active" : ""}`} title="Settings" onClick={e => { e.stopPropagation(); setShowMyProfileSettings(v => !v); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
                </button>
              </div>
            </div>

            <div className="sb-identity" onClick={e => { e.stopPropagation(); if (profile.avatarUrl) setViewFile({ url: profile.avatarUrl, type: "avatar-circle" }); }}>
              <div className="sb-id-avatar">
                {profile.avatarUrl
                  ? <img src={profile.avatarUrl} alt="Avatar" className="img-cover rounded-sq" />
                  : (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"}
              </div>
              <div className="sb-id-info">
                <span className="sb-id-name">{profile.displayName || profile.username || "Me"}</span>
                <span className="sb-id-status">
                  @{profile.username}
                  {wsStatus === "reconnecting" && <span style={{ color: "#fbbf24", fontSize: 9 }}> · Reconnecting…</span>}
                  {wsStatus === "offline" && <span style={{ color: "#ef4444", fontSize: 9 }}> · Connection lost</span>}
                </span>
              </div>
            </div>

            {showMyProfileSettings && (
              <div className="my-profile-settings-panel" onClick={e => e.stopPropagation()}>
                <input type="file" ref={avatarInputRef} accept="image/*" className="hidden-input" onChange={handleAvatarUpload} />

                {/* ── Account ── */}
                <div className="settings-section">
                  <div className="settings-section-label">Account</div>
                  <div className="settings-card">
                    <button className="settings-action-row settings-action-row--profile" onClick={() => setShowProfile(!showProfile)}>
                      <span className="settings-action-row__icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                      </span>
                      <span style={{ flex: 1 }}>Edit Profile</span>
                      <svg className={`chevron ${showProfile ? "chevron--up" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6,9 12,15 18,9" /></svg>
                    </button>

                    {showProfile && (
                      <div style={{ padding: "0 12px 14px", borderTop: "1px solid var(--border)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0 10px" }}>
                          <div style={{ width: 52, height: 52, borderRadius: "50%", overflow: "hidden", background: "var(--surface-2)", border: "2px solid var(--border-2)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, color: "var(--green)" }}>
                            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="Avatar" className="img-cover" /> : (profile.displayName || currentUser)?.[0]?.toUpperCase() || "?"}
                          </div>
                          <button onClick={() => avatarInputRef.current?.click()} className="avatar-upload-btn" disabled={isUploadingAvatar} style={{ flex: 1 }}>
                            {isUploadingAvatar ? "Uploading…" : "📷 Change Photo"}
                          </button>
                        </div>
                        <input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} placeholder="Display name…" className="sb-field" />
                        <div style={{ position: "relative" }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)", fontWeight: 700, fontSize: 13 }}>@</span>
                          <input value={editUsername} onChange={e => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} placeholder="username" className="sb-field" style={{ paddingLeft: 24 }} />
                        </div>
                        <p className="text-muted-sm text-muted-sm-margin">Username is how others find you on Flux.</p>
                        <button onClick={saveProfile} className="sb-save-btn">Save Profile</button>
                      </div>
                    )}

                    <button onClick={logout} className="settings-action-row settings-action-row--danger">
                      <span className="settings-action-row__icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                      </span>
                      Sign Out
                    </button>
                  </div>
                </div>

                {/* ── Preferences ── */}
                <div className="settings-section">
                  <div className="settings-section-label">Preferences</div>
                  <div className="settings-card" style={{ display: "flex", flexDirection: "column" }}>
                    <div className="ringtone-current-row">
                      <div className="ringtone-current-info">
                        <span className="settings-ringtone-icon" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: "50%", background: "rgba(var(--green-rgb),0.1)", color: "var(--green)" }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                        </span>
                        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                          <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Call Ringtone</span>
                          <span className="ringtone-current-name">
                            {ringtonePref === "ringtone" && "Flux Default"}
                            {ringtonePref === "ringtone2" && "Digital Alarm"}
                            {ringtonePref === "ringtone3" && "Retro Phone"}
                            {ringtonePref === "custom_file" && (customRingtoneName || "Custom Ringtone")}
                            {!["ringtone", "ringtone2", "ringtone3", "custom_file"].includes(ringtonePref) && (systemRingtones.find(r => r.uri === ringtonePref)?.name || "System Ringtone")}
                          </span>
                        </div>
                      </div>
                      <button onClick={() => setShowRingtonePicker(!showRingtonePicker)} className="ringtone-change-btn">
                        {showRingtonePicker ? "Close" : "Change"}
                      </button>
                    </div>

                    {showRingtonePicker && (
                      <div className="ringtone-picker-list" style={{ borderTop: "1px solid var(--border)" }}>
                        <div className="ringtone-category"><span className="ringtone-category-icon">🎵</span> Built-in Ringtones</div>
                        {[
                          { id: "ringtone", name: "Flux Default" },
                          { id: "ringtone2", name: "Digital Alarm" },
                          { id: "ringtone3", name: "Retro Phone" },
                        ].map(item => (
                          <div key={item.id} onClick={() => handleRingtoneChange(item.id)} className={`ringtone-option ${ringtonePref === item.id ? "ringtone-option--active" : ""}`}>
                            <button onClick={e => togglePreview(e, item.id)} className={`ringtone-preview-btn ${previewActive === item.id ? "ringtone-preview-btn--playing" : ""}`} title="Preview">
                              {previewActive === item.id
                                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
                            </button>
                            <span className="ringtone-option-name">{item.name}</span>
                            <div className={`ringtone-check ${ringtonePref === item.id ? "ringtone-check--active" : ""}`}>
                              {ringtonePref === item.id && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>}
                            </div>
                          </div>
                        ))}

                        <div className="ringtone-category" style={{ marginTop: 6 }}><span className="ringtone-category-icon">📱</span> System Ringtones</div>
                        {!IS_NATIVE ? (
                          <div className="ringtone-option" style={{ opacity: 0.5, cursor: "not-allowed" }}>
                            <span className="ringtone-option-name" style={{ fontStyle: "italic", fontSize: 12 }}>System ringtones available on Android</span>
                          </div>
                        ) : systemRingtones.length === 0 ? (
                          <div className="ringtone-option" style={{ opacity: 0.6 }}>
                            <span className="ringtone-option-name" style={{ fontStyle: "italic", fontSize: 12 }}>No system ringtones found</span>
                          </div>
                        ) : (
                          <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                            {systemRingtones.map(r => (
                              <div key={r.uri} onClick={() => handleRingtoneChange(r.uri)} className={`ringtone-option ${ringtonePref === r.uri ? "ringtone-option--active" : ""}`}>
                                <button onClick={e => togglePreview(e, r.uri)} className={`ringtone-preview-btn ${previewActive === r.uri ? "ringtone-preview-btn--playing" : ""}`} title="Preview">
                                  {previewActive === r.uri
                                    ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                    : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
                                </button>
                                <span className="ringtone-option-name">{r.name}</span>
                                <div className={`ringtone-check ${ringtonePref === r.uri ? "ringtone-check--active" : ""}`}>
                                  {ringtonePref === r.uri && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="ringtone-category" style={{ marginTop: 6 }}><span className="ringtone-category-icon">📁</span> Custom Ringtone</div>
                        {customRingtoneName && (
                          <div onClick={() => handleRingtoneChange("custom_file")} className={`ringtone-option ${ringtonePref === "custom_file" ? "ringtone-option--active" : ""}`}>
                            <button onClick={e => togglePreview(e, "custom_file")} className={`ringtone-preview-btn ${previewActive === "custom_file" ? "ringtone-preview-btn--playing" : ""}`} title="Preview custom">
                              {previewActive === "custom_file"
                                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
                            </button>
                            <span className="ringtone-option-name" style={{ color: "var(--green)", fontWeight: 500 }}>{customRingtoneName}</span>
                            <div className={`ringtone-check ${ringtonePref === "custom_file" ? "ringtone-check--active" : ""}`}>
                              {ringtonePref === "custom_file" && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>}
                            </div>
                          </div>
                        )}
                        <label className="ringtone-upload-row">
                          <input type="file" accept="audio/*" onChange={handleCustomRingtoneUpload} style={{ display: "none" }} />
                          <span style={{ fontSize: 16 }}>📤</span>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>
                            {customRingtoneName ? "Upload a different audio file" : "Upload custom audio from device"}
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Privacy ── */}
                <div className="settings-section">
                  <div className="settings-section-label">Privacy</div>
                  <div className="settings-card">
                    <button className="settings-action-row" onClick={() => setShowBlockedList(!showBlockedList)}>
                      <span className="settings-action-row__icon" style={{ color: "var(--danger)", background: "var(--danger-dim)" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
                      </span>
                      <span style={{ flex: 1, color: blockedUsers.size > 0 ? "var(--danger)" : "inherit" }}>Blocked Users</span>
                      <span style={{ background: blockedUsers.size > 0 ? "var(--danger-dim)" : "rgba(255,255,255,0.08)", color: blockedUsers.size > 0 ? "var(--danger)" : "inherit", padding: "2px 6px", borderRadius: 10, fontSize: 11, marginRight: 6, border: blockedUsers.size > 0 ? "1px solid var(--danger-border)" : "none" }}>{blockedUsers.size}</span>
                      <svg className={`chevron ${showBlockedList ? "chevron--up" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6,9 12,15 18,9" /></svg>
                    </button>
                    {showBlockedList && (
                      <div style={{ padding: "10px 12px 14px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
                        {blockedUsers.size === 0 ? (
                          <p className="text-muted-sm" style={{ margin: 0, textAlign: "center" }}>No blocked users</p>
                        ) : Array.from(blockedUsers).map(email => (
                          <div key={email} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <span style={{ fontSize: 13, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", flex: 1, color: "var(--danger)" }}>{email}</span>
                            <button onClick={() => unblockUser(email)} style={{ background: "none", border: "none", color: "var(--green)", fontSize: 12, cursor: "pointer", fontWeight: "bold", padding: "4px 8px" }}>Unblock</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ height: 6 }} />
              </div>
            )}

            <div className="sb-divider" />

            <div className="sb-search-container">
              <div className="sb-search-wrap">
                <svg className="sb-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search conversations…" className="sb-search-input" />
                {searchQuery && <button onClick={() => setSearchQuery("")} className="sb-search-clear" aria-label="Clear search">✕</button>}
              </div>
              {totalUnread > 0 && (
                <button onClick={e => { e.stopPropagation(); markAllRead(); }} className="sb-mark-read-btn">✓ All</button>
              )}
            </div>

            {searchQuery.trim() !== "" && sortedChats.length === 0 && searchMessageResults.length === 0 ? (
              <div className="sb-empty-state">
                <div className="sb-empty-state-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                </div>
                <div className="sb-empty-state-title">No results found</div>
                <p className="sb-empty-state-text">No contacts, groups, or messages match &ldquo;{searchQuery}&rdquo;</p>
              </div>
            ) : (
              <>
                {searchQuery && searchMessageResults.length > 0 && (
                  <div className="sb-section search-results-section">
                    <div className="sb-section-hdr"><div className="sb-section-label-group"><span className="sb-section-label-text">Messages</span></div></div>
                    <div className="sb-list">
                      {searchMessageResults.map(m => {
                        const groupName = groups.find(g => String(g.id) === String(m.chatId))?.name;
                        const c = contacts.find(c => c.email === String(m.chatId));
                        const chatName = m.chatType === "group" ? groupName : (c ? contactLabel(c) : "Unknown User");
                        return (
                          <button key={`${m.chatId}-${m.id}`} className="sb-item" onClick={() => openChat({ type: m.chatType, id: String(m.chatId), name: String(chatName || "Chat") })}>
                            <div className="sb-item-body mw-0">
                              <span className="sb-item-name name-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span className="text-truncate" style={{ flexShrink: 1 }}>{String(chatName || "Chat")}</span>
                                {m.chatType === "group" && <span className="group-badge" style={{ flexShrink: 0 }}>Group</span>}
                              </span>
                              <span className="sb-item-status text-truncate">{m.content}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="sb-divider" />
                  </div>
                )}

                <div className="sb-section">
                  <div className="sb-section-hdr">
                    <div className="sb-section-label-group">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                      <span className="sb-section-label-text">Chats</span>
                    </div>
                  </div>
                  <div className="sb-list">
                    {sortedChats.map(chat => {
                      if (chat.type === "user") {
                        const c = chat.item;
                        return (
                          <ContactItem
                            key={c.email}
                            contact={c}
                            isActive={activeChat?.id === c.email}
                            isDeleteTarget={sidebarDeleteId === c.email}
                            unreadCount={unread[c.email] || 0}
                            lastPreview={lastPreview[c.email] || ""}
                            label={contactLabel(c)}
                            nickname={nicknames[c.email]}
                            lastActivityTs={chat.lastActivityTs}
                            onOpen={() => openChat({ type: "user", id: c.email, name: contactLabel(c) })}
                            onDelete={() => deleteChat("user", c.email)}
                            onDeleteTarget={setSidebarDeleteId}
                            onClearDelete={() => setSidebarDeleteId(null)}
                            isChatMuted={isChatMuted}
                            onOpenProfile={() => {
                              openChat({ type: "user", id: c.email, name: contactLabel(c) });
                              setOpenedProfileFromSidebar(true);
                              setShowContactProfile(true);
                            }}
                          />
                        );
                      } else {
                        const g = chat.item;
                        return (
                          <GroupItem
                            key={g.id}
                            group={g}
                            isActive={activeChat?.id === g.id}
                            isDeleteTarget={sidebarDeleteId === String(g.id)}
                            unreadCount={unread[String(g.id)] || 0}
                            lastPreview={lastPreview[String(g.id)] || ""}
                            lastActivityTs={chat.lastActivityTs}
                            onOpen={() => openChat({ type: "group", id: g.id, name: g.name })}
                            onDelete={() => deleteChat("group", g.id)}
                            onDeleteTarget={setSidebarDeleteId}
                            onClearDelete={() => setSidebarDeleteId(null)}
                            isChatMuted={isChatMuted}
                            onOpenProfile={() => {
                              openChat({ type: "group", id: g.id, name: g.name });
                              setOpenedProfileFromSidebar(true);
                              setShowGroupProfile(true);
                            }}
                          />
                        );
                      }
                    })}
                  </div>
                </div>
              </>
            )}

            <div className="sb-footer-sticky">
              {showNewContact && (
                <div className="sb-add-form drop" style={{ marginBottom: 4 }}>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-3)", fontWeight: 700, fontSize: 13 }}>@</span>
                    <input
                      value={newContactUsername}
                      onChange={e => setNewContactUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                      onKeyDown={e => { if (e.key === "Enter") { addContactByUsername(newContactUsername); setNewContactUsername(""); setShowNewContact(false); } }}
                      placeholder="username"
                      className="sb-field"
                      style={{ paddingLeft: 22 }}
                      autoFocus
                    />
                  </div>
                  <p className="text-muted-sm">Search by @username</p>
                  <button onClick={() => { addContactByUsername(newContactUsername); setNewContactUsername(""); setShowNewContact(false); }} className="sb-go-btn">Start chat</button>
                </div>
              )}

              {showNewGroup && (
                <div className="sb-add-form drop" style={{ marginBottom: 4 }}>
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name *" className="sb-field" />
                  <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} placeholder="Description (optional)" className="sb-field" />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 8px", background: "var(--surface-2)", borderRadius: 8, minHeight: 38, alignItems: "center" }}>
                    {newGroupMemberChips.map(chip => (
                      <span key={chip} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--primary)", color: "#fff", borderRadius: 20, padding: "2px 10px", fontSize: 12 }}>
                        @{chip}
                        <button onClick={() => setNewGroupMemberChips(prev => prev.filter(c => c !== chip))} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }} aria-label="Remove member">×</button>
                      </span>
                    ))}
                    <input
                      value={newGroupMemberInput}
                      onChange={e => {
                        const val = e.target.value;
                        const start = e.target.selectionStart;
                        const end = e.target.selectionEnd;
                        setNewGroupMemberInput(val);
                        const input = e.target;
                        requestAnimationFrame(() => {
                          try { input.setSelectionRange(start, end); } catch {}
                        });
                      }}
                      onKeyDown={e => {
                        if ((e.key === "Enter" || e.key === " ") && newGroupMemberInput.trim()) {
                          e.preventDefault();
                          const uname = newGroupMemberInput.trim().replace(/^@/, "");
                          if (uname && !newGroupMemberChips.includes(uname)) setNewGroupMemberChips(prev => [...prev, uname]);
                          setNewGroupMemberInput("");
                        }
                      }}
                      placeholder={newGroupMemberChips.length === 0 ? "Add @username & press Enter" : "Add more…"}
                      style={{ border: "none", outline: "none", background: "transparent", flex: 1, minWidth: 120, fontSize: 13, color: "var(--text-1)", padding: "2px 4px" }}
                    />
                  </div>
                  <button
                    onClick={async () => {
                      const allChips = newGroupMemberInput.trim()
                        ? [...newGroupMemberChips, newGroupMemberInput.trim().replace(/^@/, "")]
                        : newGroupMemberChips;
                      if (!newGroupName.trim()) return;
                      const memberEmails: string[] = [];
                      const failedLookups: string[] = [];
                      for (const uname of allChips) {
                        if (uname.includes("@")) { memberEmails.push(uname); continue; }
                        try {
                          const prof = await apiFetch<{ email: string }>(`/profile/by-username/${encodeURIComponent(uname)}`);
                          memberEmails.push(prof.email);
                        } catch { failedLookups.push(uname); }
                      }
                      if (failedLookups.length > 0) { showToast("Usernames not found: " + failedLookups.map(u => "@" + u).join(", "), "error"); return; }
                      try {
                        const group = await apiFetch<any>("/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc, members: memberEmails }) });
                        try {
                          const { keyId, groupKey } = await generateGroupKey();
                          const privKey = e2ePrivKeyRef.current;
                          const myPubB64 = e2ePubKeyB64Ref.current;
                          if (privKey && myPubB64) {
                            const memberKeyEntries: { email: string; encrypted_key: string }[] = [];
                            for (const memberEmail of [...memberEmails, currentUser]) {
                              const theirPub = memberEmail === currentUser ? myPubB64 : await getPeerPubKey(memberEmail);
                              if (theirPub) {
                                const encKey = await wrapGroupKeyForMember({ keyId, groupKey }, privKey, theirPub);
                                memberKeyEntries.push({ email: memberEmail, encrypted_key: encKey });
                              }
                            }
                            if (memberKeyEntries.length > 0) {
                              await apiFetch(`/groups/${group.id}/e2e-key`, { method: "POST", body: JSON.stringify({ key_id: keyId, setter_pub_key: myPubB64, member_keys: memberKeyEntries }) });
                              groupKeyCache.set(String(group.id), groupKey);
                            }
                          }
                        } catch { }
                        setNewGroupName(""); setNewGroupDesc(""); setNewGroupMemberChips([]); setNewGroupMemberInput(""); setShowNewGroup(false);
                        loadGroups();
                      } catch (err) { showToast("Failed to create group: " + errorMessage(err), "error"); }
                    }}
                    className="sb-go-btn secondary"
                  >Create group</button>
                </div>
              )}

              <div className="sb-bottom-bar">
                <button className={`sb-bottom-btn ${showNewContact ? "active-dm" : ""}`} onClick={() => { setShowNewContact(!showNewContact); setShowNewGroup(false); }} title="New direct message">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                  New DM
                </button>
                <button className={`sb-bottom-btn ${showNewGroup ? "active-group" : ""}`} onClick={() => { setShowNewGroup(!showNewGroup); setShowNewContact(false); }} title="New group">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>
                  New Group
                </button>
              </div>
            </div>
          </aside>

          {/* ── CHAT MAIN ─────────────────────────────────────────────────────── */}
          <main className="chat">
            {!chat ? (
              <div className="empty-state">
                <div className="empty-rings" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div className="ring r1" /><div className="ring r2" /><div className="ring r3" />
                  <img className="z-1-relative" src="/icon.png" alt="Flux" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }} />
                </div>
                <h3>No conversation open</h3>
                <p>Select a contact or group to start messaging</p>
              </div>
            ) : (
              <>
                {/* ── HEADER ── */}
                <header className="chat-hdr">
                  {selectedMsgIds.size > 0 ? (() => {
                    const selectedMsgs = messages.filter(m => selectedMsgIds.has(m.id));
                    const isSingle = selectedMsgs.length === 1;
                    const singleMsg = selectedMsgs[0];
                    const isSingleMine = isSingle && singleMsg?.user === currentUser;
                    return (
                      <div className="msg-selection-header-content" style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, overflow: "hidden" }}>
                          <button className="tool-btn" style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--surface-hover)", border: "none" }} onClick={() => toggleSelectMsg(null)} aria-label="Cancel selection">✕</button>
                          <span style={{ fontSize: 15, fontWeight: 650, color: "#fff", whiteSpace: "nowrap" }}>{selectedMsgIds.size} {selectedMsgIds.size === 1 ? "message" : "messages"} selected</span>
                        </div>
                        <div className="hdr-action-buttons" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          {isSingle && singleMsg && (
                            <>
                              {(() => {
                                const isPinned = (pinnedMessages[String(chat.id)] || []).some(m => m.id === singleMsg.id);
                                return (
                                  <button
                                    onClick={() => togglePinMessage(singleMsg)}
                                    className={`tool-btn ${isPinned ? "active-pin" : ""}`}
                                    title={isPinned ? "Unpin message" : "Pin message"}
                                    aria-label={isPinned ? "Unpin message" : "Pin message"}
                                  >
                                    📌
                                  </button>
                                );
                              })()}
                              <button onClick={() => { setReplyingTo(singleMsg); toggleSelectMsg(null); }} className="tool-btn" title="Reply" aria-label="Reply to message">↩</button>
                            </>
                          )}
                          <button
                            onClick={() => {
                              const sorted = [...selectedMsgs].sort((a, b) => parseTs(a.timestamp).getTime() - parseTs(b.timestamp).getTime());
                              setForwardingMsgs(sorted);
                              setShowForwardPicker(true);
                              toggleSelectMsg(null);
                            }}
                            className="tool-btn"
                            title="Forward"
                            aria-label="Forward message"
                          >
                            ↗
                          </button>
                          {isSingle && isSingleMine && singleMsg && (
                            <>
                              <button onClick={() => { setEditingId(singleMsg.id); setEditingText(singleMsg.content); toggleSelectMsg(null); }} className="tool-btn" title="Edit" aria-label="Edit message">✎</button>
                              {chat.type === "group" && (
                                <button onClick={() => { setMessageInfoMsg(singleMsg); toggleSelectMsg(null); }} className="tool-btn" title="Message Info" aria-label="View message info">ⓘ</button>
                              )}
                            </>
                          )}
                          <button
                            onClick={async () => {
                              const confirmMsg = `Delete these ${selectedMsgs.length} messages? Only you will lose them.`;
                              if (!window.confirm(confirmMsg)) return;
                              for (const m of selectedMsgs) {
                                await deleteMsg(m.id);
                              }
                              toggleSelectMsg(null);
                            }}
                            className="tool-btn del-action"
                            title="Delete"
                            aria-label="Delete message"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    );
                  })() : (
                    <>
                      <div className="chat-hdr-left">
                        <button className="mobile-back-btn" onClick={() => setActiveChat(null)} aria-label="Back to chat list">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                        </button>
                        <div
                          className={`hdr-av ${chat.type === "group" ? "hdr-av--group" : ""} cursor-pointer pointer-relative`}
                          onClick={() => chat.type === "user" ? setShowContactProfile(true) : setShowGroupProfile(true)}
                        >
                          {chat.type === "user" && contacts.find(c => c.email === chat.id)?.avatar_url
                            ? <img src={contacts.find(c => c.email === chat.id)!.avatar_url!} alt="avatar" className="img-cover rounded-circle" />
                            : chat.type === "group" && groups.find(g => g.id === chat.id)?.avatar_url
                              ? <img src={groups.find(g => g.id === chat.id)!.avatar_url!} alt="group" className="img-cover rounded-circle" />
                              : chat.name?.[0]?.toUpperCase() || "?"}
                          <div className="hdr-av-overlay">view</div>
                        </div>
                        <div className="hdr-info">
                          <div className="name-row-inline">
                            <span className="hdr-name">
                              {chat.type === "user"
                                ? (() => { const c = contacts.find(c => c.email === chat.id); return c ? contactLabel(c) : chat.name; })()
                                : chat.name}
                            </span>
                            {chat.type === "group" && <span className="group-badge" style={{ flexShrink: 0 }}>Group</span>}
                            {chat.type === "user" && (
                              <button onClick={openHeaderNicknameEdit} className={`btn-pencil-nickname ${showHeaderNicknameEdit ? "active" : ""}`} aria-label="Edit nickname">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                              </button>
                            )}
                          </div>
                          {chat.type === "user" && (() => { const c = contacts.find(c => c.email === chat.id); return c?.username ? <span className="hdr-meta hdr-meta-nickname">@{c.username}</span> : null; })()}
                          <span className="hdr-meta">
                            {chat.type === "user" ? (
                              <><span className={`hdr-dot ${contacts.find(c => c.email === chat.id)?.is_online ? "hdr-dot--on" : ""}`} />{contacts.find(c => c.email === chat.id)?.is_online ? "Online" : "Offline"}</>
                            ) : <>{groups.find(g => g.id === chat.id)?.members.length || "?"} members</>}
                          </span>
                        </div>
                      </div>
                      <div className="hdr-right">
                        <button onClick={() => startCall(false)} className="tool-btn" title="Voice Call" aria-label="Start voice call">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>
                        </button>
                        <button onClick={() => startCall(true)} className="tool-btn" title="Video Call" aria-label="Start video call">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                        </button>

                        <div style={{ position: "relative" }}>
                          <button
                            onClick={e => { e.stopPropagation(); setShowMuteMenu(v => !v); }}
                            className={`tool-btn ${isChatMuted(String(chat.id)) ? "tool-btn--on" : ""}`}
                            title={isChatMuted(String(chat.id)) ? "Unmute notifications" : "Mute notifications"}
                            aria-label="Mute notifications"
                          >
                            {isChatMuted(String(chat.id)) ? (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13.73 21a2 2 0 01-3.46 0" /><path d="M18.63 13A17.9 17.9 0 0118 8" /><path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 00-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                            ) : (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>
                            )}
                          </button>
                          {showMuteMenu && (
                            <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 900, background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 8px 24px rgba(0,0,0,0.2)", minWidth: 160, overflow: "hidden" }} onClick={e => e.stopPropagation()}>
                              {isChatMuted(String(chat.id)) ? (
                                <button className="mute-menu-item" onClick={() => unmuteChat(String(chat.id), chat.type)}>🔔 Unmute</button>
                              ) : (
                                <>
                                  <div style={{ padding: "8px 14px 4px", fontSize: 10, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Mute for…</div>
                                  {(["8h", "1w", "forever"] as const).map(d => (
                                    <button key={d} className="mute-menu-item" onClick={() => muteChat(String(chat.id), chat.type, d)}>
                                      {d === "8h" ? "🔕 8 hours" : d === "1w" ? "🔕 1 week" : "🔕 Forever"}
                                    </button>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </div>

                        <button className="tool-btn" title="Delete chat" aria-label="Delete chat" onClick={() => { if (window.confirm("Delete this chat? Only you will lose it.")) deleteChat(chat.type, chat.id); }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6M9 6V4h6v2" /></svg>
                        </button>
                      </div>
                    </>
                  )}
                </header>

                {/* ── PINS BANNER ── */}
                {(() => {
                  const chatId = String(chat.id);
                  const chatPins = pinnedMessages[chatId] || [];
                  if (chatPins.length === 0) return null;
                  const latestPin = chatPins[chatPins.length - 1];
                  return (
                    <div className="pin-bar">
                      <div className="pin-bar-content" onClick={() => scrollToPinnedMessage(latestPin.id)}>
                        <span className="pin-bar-title">📌 Pinned Message</span>
                        <span className="pin-bar-text">
                          {latestPin.content.startsWith("[") ? "📎 Attachment" : latestPin.content}
                        </span>
                      </div>
                      <div className="pin-bar-actions">
                        <button className="pin-bar-btn" onClick={() => togglePinMessage(latestPin)} aria-label="Unpin">✕</button>
                      </div>
                    </div>
                  );
                })()}


                {showHeaderNicknameEdit && chat.type === "user" && (
                  <div className="nickname-edit-panel">
                    <span className="nickname-edit-label">🏷 Nickname:</span>
                    <input
                      value={headerNicknameValue}
                      onChange={e => setHeaderNicknameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveContactNickname(String(chat.id), headerNicknameValue); if (e.key === "Escape") setShowHeaderNicknameEdit(false); }}
                      placeholder={(() => { const c = contacts.find(c => c.email === chat.id); return `Nickname for ${c?.display_name || (c?.username ? `@${c.username}` : chat.name)}`; })()}
                      className="sb-field nickname-edit-input"
                      autoFocus
                    />
                    <div className="nickname-edit-actions">
                      <button onClick={() => saveContactNickname(String(chat.id), headerNicknameValue)} className="sb-go-btn btn-save-sm">Save</button>
                      {nicknames[String(chat.id)] && <button onClick={() => saveContactNickname(String(chat.id), "")} className="sb-go-btn btn-clear-sm">Clear</button>}
                      <button onClick={() => setShowHeaderNicknameEdit(false)} className="sb-go-btn btn-close-sm" aria-label="Close nickname editor">✕</button>
                    </div>
                  </div>
                )}

                {/* ── MESSAGE LIST ── */}
                <div ref={msgListRef} className="msg-list" onClick={handleAppClick} style={{ position: "relative" }}>
                  <div ref={loadMoreSentinelRef} style={{ height: 1, position: "absolute", top: 0, left: 0, right: 0 }} />
                  {loadingMore && (
                    <div className="load-more-row" style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "var(--surface-2)", border: "1px solid var(--border)", padding: "6px 16px", borderRadius: 100, boxShadow: "0 4px 12px rgba(0,0,0,0.15)" }}>
                      <span className="spinner" style={{ width: 14, height: 14 }} />
                      <span style={{ fontSize: 12, color: "var(--text-2)", marginLeft: 6 }}>Loading older messages…</span>
                    </div>
                  )}

                  {isLoadingHistory ? (
                    <div className="skeleton-container">
                      {[
                        { cls: "theirs", lines: ["short", "long"] },
                        { cls: "mine", lines: ["medium"] },
                        { cls: "theirs", lines: ["long", "short"] },
                        { cls: "mine", lines: ["long"] },
                      ].map((b, i) => (
                        <div key={i} className={`skeleton-bubble ${b.cls}`}>
                          {b.lines.map((l, j) => <div key={j} className={`skeleton-line ${l}`} />)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                      {rowVirtualizer.getVirtualItems().map(virtualRow => {
                        const item = groupedMessages[virtualRow.index];
                        if (!item) return null;
                        return (
                          <div
                            key={virtualRow.key}
                            ref={rowVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                          >
                            {item.type === "divider" ? (
                              <div className="date-sep"><span>{item.label}</span></div>
                            ) : (
                              <MessageBubble
                                item={item} currentUser={currentUser}
                                isSelected={selectedMsgIds.has(item.id)}
                                isSelectionModeActive={selectedMsgIds.size > 0}
                                isEditing={editingId === item.id}
                                editingText={editingText}
                                reactionPickerId={reactionPickerId}
                                chatType={chat.type}
                                reactionEmojis={reactionEmojis}
                                contacts={contacts}
                                getPeerName={getPeerName}
                                contactLabel={contactLabel}
                                isFailed={failedMsgIds.has(String(item.id))}
                                onReply={msg => { setReplyingTo(msg); setReactionPickerId(null); toggleSelectMsg(null); }}
                                onForward={msg => { setForwardingMsgs([msg]); setShowForwardPicker(true); toggleSelectMsg(null); }}
                                onEditStart={(id, text) => { setEditingId(id); setEditingText(text); setReactionPickerId(null); toggleSelectMsg(null); }}
                                onEditSave={saveEdit}
                                onEditCancel={() => setEditingId(null)}
                                onEditChange={setEditingText}
                                onDelete={id => { deleteMsg(id); toggleSelectMsg(null); }}
                                onReaction={sendReaction}
                                onSetReactionPicker={setReactionPickerId}
                                onViewFile={(url, type) => setViewFile({ url, type })}
                                onSelectMsg={toggleSelectMsg}
                                onRetry={retryMessage}
                                highlightedMsgId={highlightedMsgId}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── TYPING ── */}
                <div className="typing-area">
                  {isTyping && (
                    <div className="typing-pill">
                      <span className="td" /><span className="td" /><span className="td" />
                      <span>{(() => { const c = contacts.find(c => c.email === String(chat.id)); return c ? contactLabel(c) : chat.name; })()} is typing…</span>
                    </div>
                  )}
                </div>

                {/* ── REPLY BANNER ── */}
                {replyingTo && (
                  <div className="reply-banner">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--green)", marginBottom: 2 }}>
                        ↩ Replying to {replyingTo.user === currentUser ? "yourself" : (replyingTo.sender_name || getPeerName(replyingTo.user))}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {replyingTo.content.startsWith("[") ? "📎 Attachment" : replyingTo.content}
                      </div>
                    </div>
                    <button onClick={() => setReplyingTo(null)} style={{ marginLeft: 8, padding: "4px 8px", border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--text-3)" }} aria-label="Cancel reply">✕</button>
                  </div>
                )}

                {/* ── EMOJI / STICKER PANEL ── */}
                {showEmojiPanel && (
                  <div className="emoji-picker pop" style={{ height: 320, display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--surface-1)", flexShrink: 0 }}>
                      {(["emojis", "stickers"] as const).map(tab => (
                        <button
                          key={tab}
                          onClick={() => setEmojiPanelTab(tab)}
                          style={{ flex: 1, padding: 10, border: "none", background: emojiPanelTab === tab ? "var(--surface-3)" : "transparent", color: emojiPanelTab === tab ? "var(--primary)" : "var(--text-2)", fontWeight: emojiPanelTab === tab ? "bold" : "normal", cursor: "pointer", fontSize: 13, borderBottom: emojiPanelTab === tab ? "2px solid var(--primary)" : "none" }}
                        >
                          {tab === "emojis" ? "😀 Emojis" : "🖼️ Stickers"}
                        </button>
                      ))}
                    </div>
                    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
                      {emojiPanelTab === "emojis" ? (
                        <div role="grid" aria-label="Emoji picker" style={{ padding: 8 }}>
                          {emojiRows.map((row, r) => (
                            <div key={r} role="row" style={{ display: "flex", gap: 2 }}>
                              {row.map((e, c) => {
                                const isFocused = r === focusedEmojiCoord.r && c === focusedEmojiCoord.c;
                                return (
                                  <button
                                    key={e}
                                    ref={isFocused ? emojiActiveCellRef : null}
                                    tabIndex={isFocused ? 0 : -1}
                                    onClick={() => setInputMsg(prev => prev + e)}
                                    onKeyDown={ev => handleEmojiKeyDown(ev, r, c)}
                                    className="emoji-cell"
                                    role="gridcell"
                                    aria-label={e}
                                  >
                                    {e}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                          <div style={{ display: "flex", gap: 4, padding: "8px 10px 6px", borderBottom: "1px solid var(--border)", overflowX: "auto", flexShrink: 0 }}>
                            {stickerPacks.map(pack => (
                              <button key={pack.id} onClick={() => setActiveStickerPack(pack.id)} title={pack.name} style={{ background: activeStickerPack === pack.id ? "var(--surface-3)" : "transparent", border: activeStickerPack === pack.id ? "1px solid var(--border-2)" : "1px solid transparent", borderRadius: 8, padding: 3, cursor: "pointer", flexShrink: 0 }}>
                                <img src={pack.thumbnail_url} alt={pack.name} style={{ width: 28, height: 28, objectFit: "contain" }} />
                              </button>
                            ))}
                          </div>
                          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                            {loadingStickers ? (
                              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
                                <span className="spinner" style={{ width: 20, height: 20 }} />
                              </div>
                            ) : activeStickerPack && packStickers[activeStickerPack] ? (
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 4 }}>
                                {packStickers[activeStickerPack].map(sticker => (
                                  <button key={sticker.id} onClick={() => sendSticker(sticker.url)} title={sticker.name || ""} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 8, transition: "background 0.15s" }} onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")} onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                                    <img src={sticker.url} alt={sticker.name || "sticker"} style={{ width: 48, height: 48, objectFit: "contain", display: "block" }} loading="lazy" />
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div style={{ textAlign: "center", color: "var(--text-3)", fontSize: 13, marginTop: 20 }}>Select a pack above</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── INPUT BAR ── */}
                <div className="input-bar">
                  {isRecording ? (
                    <div style={{ display: "flex", alignItems: "center", flex: 1, padding: "0 10px", gap: 16 }}>
                      <div className="rec-dot" style={{ position: "static", display: "inline-block", width: 10, height: 10 }} />
                      <span style={{ color: "var(--red)", fontWeight: 600, flex: 1 }}>Recording · {fmtDuration(recordingDuration)}</span>
                      <button onClick={() => { cancelRecordingRef.current = true; toggleRecording(); }} style={{ color: "var(--text-3)", background: "none", border: "none", cursor: "pointer", fontSize: 14 }}>Cancel</button>
                      <button onClick={toggleRecording} className="send-btn" aria-label="Send voice message">➤</button>
                    </div>
                  ) : (
                    <>
                      <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*,audio/*,video/*,.pdf,.doc,.docx" className="hidden-input" multiple />
                      <input type="file" ref={cameraPhotoInputRef} onChange={handleFile} accept="image/*" capture="environment" className="hidden-input" />
                      <input type="file" ref={cameraVideoInputRef} onChange={handleFile} accept="video/*" capture="environment" className="hidden-input" />

                      <div className="msg-input-wrapper">
                        <button ref={emojiToggleRef} onClick={e => { e.stopPropagation(); setShowEmojiPanel(v => !v); }} className={`input-inline-btn ${showEmojiPanel ? "active" : ""}`} aria-label="Emoji & Stickers" aria-expanded={showEmojiPanel} type="button">😀</button>
                        <input
                          value={inputMsg}
                          onChange={handleTyping}
                          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setTimeout(() => sendMessage(), 0); } }}
                          placeholder={isUploadingAttachment ? "Sending..." : "Type a message…"}
                          className="msg-input-field"
                          disabled={isRecording || isUploadingAttachment}
                        />
                        <button onClick={() => fileInputRef.current?.click()} className="input-inline-btn" title="Attach file" aria-label="Attach file" type="button">📎</button>
                        <button onClick={() => setShowCameraDrawer(true)} className="input-inline-btn" title="Take photo or video" aria-label="Camera" type="button">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                        </button>
                      </div>

                      {inputMsg.trim() || pendingFile || pendingFiles.length > 0 ? (
                        <button onClick={sendMessage} disabled={isRecording || isUploadingAttachment} className="send-btn" aria-label="Send message">➤</button>
                      ) : (
                        <button onClick={toggleRecording} className={`mic-btn-circle ${isRecording ? "tool-btn--rec" : ""}`} title="Voice message" aria-label="Record voice message">🎤</button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )
      }

      {/* ── CALL LOG MODAL ────────────────────────────────────────────────────── */}
      {
        showCallLogUI && (
          <div className="file-viewer-overlay" onClick={() => setShowCallLogUI(false)}>
            <div className="viewer-content cl-modal" onClick={e => e.stopPropagation()}>
              <div className="cl-header">
                <h2 className="cl-title">Call History</h2>
                <button className="cl-close" onClick={() => setShowCallLogUI(false)} aria-label="Close call history">✕</button>
              </div>
              {callLogs.length === 0 ? (
                <p className="cl-empty">No recent calls</p>
              ) : (
                <div className="cl-list">
                  {callLogs.map(log => (
                    <div key={log.id} className="cl-item">
                      <div>
                        <strong className={`cl-item-name ${log.status !== "completed" ? "missed" : ""}`}>{log.peerName || getPeerName(log.peer)}</strong>
                        <span className="cl-item-meta">
                          <span>{log.direction === "incoming" ? "↙ Incoming" : "↗ Outgoing"}</span>
                          <span>•</span>
                          <span>{log.media === "video" ? "📹 Video" : "📞 Audio"}</span>
                          <span>•</span>
                          <span>{parseTs(log.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        </span>
                      </div>
                      <div className="cl-item-dur">
                        {log.status === "completed" ? fmtDuration(log.duration) : <span className="cl-item-dur status">{log.status}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      }

      {/* ── CALL OVERLAY ──────────────────────────────────────────────────────── */}
      {callState === "incoming" && (
        <div className="full-screen-incoming-call">
          {(() => {
            const peerContact = contacts.find(c => c.email === callPeer);
            if (peerContact?.avatar_url) {
              return <div className="call-bg-blur" style={{ backgroundImage: `url(${peerContact.avatar_url})` }} />;
            }
            return <div className="call-bg-blur" />;
          })()}
          <div className="call-bg-gradient" />

          <div className="fc-info">
            <div className="fc-avatar-wrapper">
              <div className="fc-avatar-pulse" />
              <div className="fc-avatar">
                {(() => {
                  const peerContact = contacts.find(c => c.email === callPeer);
                  return peerContact?.avatar_url ? (
                    <img src={peerContact.avatar_url} alt={callDisplayName} className="img-cover rounded-circle" />
                  ) : (
                    callDisplayName?.[0]?.toUpperCase() || "?"
                  );
                })()}
              </div>
            </div>
            <h1 className="fc-name">{callDisplayName}</h1>
            <p className="fc-status">{isVideoCall ? "Incoming Video Call" : "Incoming Voice Call"}</p>
          </div>

          <div className="fc-sliders-container">
            <DragSlider label="Slide to Answer" type="accept" onTrigger={acceptCall} />
            <DragSlider label="Slide to Decline" type="decline" onTrigger={rejectCall} />
          </div>
        </div>
      )}

      {callState !== "idle" && callState !== "incoming" && (
        <div className="full-screen-incoming-call">
          {(() => {
            const peerContact = contacts.find(c => c.email === callPeer);
            if (peerContact?.avatar_url) {
              return <div className="call-bg-blur" style={{ backgroundImage: `url(${peerContact.avatar_url})` }} />;
            }
            return <div className="call-bg-blur" />;
          })()}
          <div className="call-bg-gradient" />

          {isVideoCall && callState === "connected" ? (
            <div className="video-container" style={{ position: "absolute", inset: 0, zIndex: 5, background: "#000", display: "flex", flexDirection: "column" }}>
              <div className="video-duration-overlay" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade80" }} />
                <span style={{ opacity: 0.85, fontWeight: 550 }}>{callDisplayName}</span>
                <span style={{ width: 1, height: 12, background: "rgba(255,255,255,0.2)" }} />
                <span>{fmtDuration(callDuration)}</span>
              </div>

              {/* Main remote view */}
              {isVideoSwapped ? (
                <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
                  <video autoPlay playsInline muted ref={node => { (localVideoRef as any).current = node; if (node && localStreamRef.current && node.srcObject !== localStreamRef.current) { node.srcObject = localStreamRef.current; node.play().catch(() => { }); } }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  {isCameraOff && (
                    <div style={{ position: "absolute", inset: 0, background: "#1a1a1a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, zIndex: 2 }}>
                      <div style={{ width: 90, height: 90, borderRadius: "50%", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 38, color: "#fff", fontWeight: 700, overflow: "hidden", border: "3px solid rgba(255,255,255,0.15)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                        {profile.avatarUrl ? <img src={profile.avatarUrl} alt="you" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (profile.displayName || profile.username || currentUser)?.[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Camera Off</span>
                    </div>
                  )}
                  <div style={{ position: "absolute", bottom: 12, left: 12, background: "rgba(0,0,0,0.65)", color: "#fff", padding: "6px 12px", borderRadius: 16, fontSize: 13, fontWeight: 500, backdropFilter: "blur(4px)", pointerEvents: "none", zIndex: 5, border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: isCameraOff ? "#94a3b8" : "#4ade80", boxShadow: isCameraOff ? "none" : "0 0 8px #4ade80" }} />You
                  </div>
                </div>
              ) : Object.keys(remoteStreams).length > 0 ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", zIndex: 1 }}>
                  {Object.entries(remoteStreams).map(([peerId, stream], idx, arr) =>
                    renderPeerVideoOrAvatar(peerId, stream, idx, arr.length)
                  )}
                </div>
              ) : (
                <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
                  {(remoteVideoMuted || (callPeer && cameraStates[callPeer])) ? (
                    <div style={{ width: "100%", height: "100%", background: "#1a1a1a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                      {(() => {
                        const peerContact = contacts.find(c => c.email === callPeer);
                        return (
                          <div style={{ width: 90, height: 90, borderRadius: "50%", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 38, color: "#fff", fontWeight: 700, overflow: "hidden", border: "3px solid rgba(255,255,255,0.15)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                            {peerContact?.avatar_url ? <img src={peerContact.avatar_url} alt={callDisplayName} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : callDisplayName?.[0]?.toUpperCase() || "?"}
                          </div>
                        );
                      })()}
                      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Camera Off</span>
                    </div>
                  ) : (
                    <video autoPlay playsInline ref={node => { (remoteVideoRef as any).current = node; if (node && remoteStreamRef.current && node.srcObject !== remoteStreamRef.current) { node.srcObject = remoteStreamRef.current; node.play().catch(() => { }); } }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                  <div style={{ position: "absolute", bottom: 12, left: 12, background: "rgba(0,0,0,0.65)", color: "#fff", padding: "6px 12px", borderRadius: 16, fontSize: 13, fontWeight: 500, backdropFilter: "blur(4px)", pointerEvents: "none", zIndex: 5, border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: (remoteVideoMuted || (callPeer && cameraStates[callPeer])) ? "#94a3b8" : "#4ade80" }} />
                    {callDisplayName}
                  </div>
                </div>
              )}

              {/* PIP video */}
              <div className="local-video-pip" style={{ left: pipPos.x, top: pipPos.y, cursor: "pointer", zIndex: 10 }} onMouseDown={onPipMouseDown} onTouchStart={onPipTouchStart} onClick={() => { if (!pipDragging.current) setIsVideoSwapped(v => !v); }} title="Tap to swap">
                <div style={{ position: "relative", width: "100%", height: "100%" }}>
                  {isVideoSwapped ? (
                    // PIP shows Remote Video
                    <>
                      {(remoteVideoMuted || (callPeer && cameraStates[callPeer])) ? (
                        <div style={{ position: "absolute", inset: 0, background: "#1a1a1a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}>
                          {(() => {
                            const peerContact = contacts.find(c => c.email === callPeer);
                            return (
                              <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, color: "#fff", fontWeight: 700, overflow: "hidden", border: "2px solid rgba(255,255,255,0.15)" }}>
                                {peerContact?.avatar_url ? <img src={peerContact.avatar_url} alt={callDisplayName} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : callDisplayName?.[0]?.toUpperCase() || "?"}
                              </div>
                            );
                          })()}
                          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Cam off</span>
                        </div>
                      ) : (
                        <video autoPlay playsInline ref={node => { (remoteVideoRef as any).current = node; if (node && remoteStreamRef.current && node.srcObject !== remoteStreamRef.current) { node.srcObject = remoteStreamRef.current; node.play().catch(() => { }); } }} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      )}
                      <div style={{ position: "absolute", bottom: 4, left: 4, background: "rgba(0,0,0,0.7)", color: "#fff", padding: "2px 6px", borderRadius: 8, fontSize: 9, fontWeight: 500, pointerEvents: "none", zIndex: 5 }}>{callDisplayName}</div>
                    </>
                  ) : (
                    // PIP shows Local Video (You)
                    <>
                      <video autoPlay playsInline muted ref={node => { (localVideoRef as any).current = node; if (node && localStreamRef.current && node.srcObject !== localStreamRef.current) { node.srcObject = localStreamRef.current; node.play().catch(() => { }); } }} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      {isCameraOff && (
                        <div style={{ position: "absolute", inset: 0, background: "#1a1a1a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}>
                          <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, color: "#fff", fontWeight: 700, overflow: "hidden", border: "2px solid rgba(255,255,255,0.15)" }}>
                            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="you" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (profile.displayName || profile.username || currentUser)?.[0]?.toUpperCase()}
                          </div>
                          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.4)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Cam off</span>
                        </div>
                      )}
                      <div style={{ position: "absolute", bottom: 4, left: 4, background: "rgba(0,0,0,0.7)", color: "#fff", padding: "2px 6px", borderRadius: 8, fontSize: 9, fontWeight: 500, pointerEvents: "none", zIndex: 5 }}>You</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="fc-info" style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, width: "100%" }}>
              <div className="fc-avatar-wrapper" style={{ width: 150, height: 150, marginBottom: 28 }}>
                <div className="fc-avatar-pulse" style={{ borderColor: "rgba(var(--green-rgb), 0.45)" }} />
                <div className="fc-avatar" style={{ width: "100%", height: "100%", fontSize: 64, border: "4px solid rgba(255, 255, 255, 0.2)" }}>
                  {(() => {
                    const peerContact = contacts.find(c => c.email === callPeer);
                    return peerContact?.avatar_url ? (
                      <img src={peerContact.avatar_url} alt={callDisplayName} className="img-cover rounded-circle" />
                    ) : (
                      callDisplayName?.[0]?.toUpperCase() || "?"
                    );
                  })()}
                </div>
              </div>
              <h1 className="fc-name" style={{ fontSize: "2.4rem", marginBottom: 12 }}>{callDisplayName}</h1>
              <p className="fc-status" style={{ color: "var(--green)", letterSpacing: "0.06em", fontWeight: 700 }}>
                {callState === "calling" ? "Calling…" : `Connected · ${fmtDuration(callDuration)}`}
              </p>
              {!isVideoCall && callState === "connected" && (
                <p style={{ fontSize: 13, opacity: 0.65, marginTop: 8 }}>{isSpeaker ? "🔊 Speaker" : "📱 Earpiece"}</p>
              )}
            </div>
          )}

          <div className="call-controls" style={{ position: "absolute", bottom: 30, left: "50%", transform: "translateX(-50%)", zIndex: 100, width: "calc(100% - 48px)", display: "flex", justifyContent: "center", gap: 18, background: "rgba(0,0,0,0.35)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 24, padding: "16px 20px", maxWidth: 420, boxShadow: "0 12px 36px rgba(0,0,0,0.5)" }}>
            {callState === "connected" ? (
              <>
                <button onClick={toggleMute} className={`call-btn btn-secondary ${isMuted ? "active-mute" : ""}`} aria-label={isMuted ? "Unmute" : "Mute"}>
                  {isMuted
                    ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                    : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>}
                </button>
                {isVideoCall && (
                  <button onClick={switchCamera} className="call-btn btn-secondary" aria-label="Switch camera">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="1 4 1 10 7 10" /><polyline points="23 20 23 14 17 14" /><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" /></svg>
                  </button>
                )}
                {isVideoCall && (
                  <button
                    onClick={() => {
                      const newOff = !isCameraOff;
                      localStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = !newOff; });
                      setIsCameraOff(newOff);
                      const signalPeers = [callPeer, ...Array.from(pcMapRef.current.keys()).filter(p => p !== callPeer)];
                      signalPeers.forEach(p => { if (p) wsSend(JSON.stringify({ type: "camera_state", target_user: p, videoMuted: newOff })); });
                    }}
                    className={`call-btn btn-secondary ${isCameraOff ? "active-mute" : ""}`}
                    aria-label={isCameraOff ? "Turn camera on" : "Turn camera off"}
                  >
                    {isCameraOff
                      ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23" /><path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34" /></svg>
                      : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>}
                  </button>
                )}
                <button onClick={toggleSpeaker} className={`call-btn btn-secondary ${!isSpeaker ? "active-mute" : ""}`} aria-label={isSpeaker ? "Switch to earpiece" : "Switch to speaker"}>
                  {isSpeaker
                    ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
                    : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014.69 12a19.79 19.79 0 01-3.07-8.67A2 2 0 013.6 1.37h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.91 9a16 16 0 006.09 6.09l1.97-1.85a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2.03z" /></svg>}
                </button>
                <button onClick={() => endCall(true)} className="call-btn btn-end" aria-label="End call">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </>
            ) : (
              <button onClick={() => endCall(true)} className="call-btn btn-end" aria-label="End call">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── MULTI-MEDIA CAROUSEL PREVIEW OVERLAY ── */}
      <MediaPreviewOverlay
        pendingFiles={pendingFiles}
        setPendingFiles={setPendingFiles}
        inputMsg={inputMsg}
        setInputMsg={setInputMsg}
        multiUploadProgress={multiUploadProgress}
        fileInputRef={fileInputRef}
        sendMessage={sendMessage}
      />

      {/* ── CAMERA ACTION DRAWER OVERLAY ── */}
      <CameraDrawer
        showCameraDrawer={showCameraDrawer}
        setShowCameraDrawer={setShowCameraDrawer}
        cameraPhotoInputRef={cameraPhotoInputRef}
        cameraVideoInputRef={cameraVideoInputRef}
      />

      {/* ── MEDIA VIEWER ──────────────────────────────────────────────────────── */}
      <MediaViewer
        viewFile={viewFile}
        onClose={() => setViewFile(null)}
        handleDownloadMedia={handleDownloadMedia}
      />

      {/* ── FORWARD PICKER ────────────────────────────────────────────────────── */}
      <ForwardPicker
        showForwardPicker={showForwardPicker}
        forwardingMsgs={forwardingMsgs}
        onClose={() => {
          setShowForwardPicker(false);
          setForwardSelectedTargets([]);
          setForwardingMsgs([]);
        }}
        sortedChats={sortedChats}
        contacts={contacts}
        contactLabel={contactLabel}
        forwardSelectedTargets={forwardSelectedTargets}
        toggleForwardTarget={toggleForwardTarget}
        handleMultiForward={handleMultiForward}
      />

      {/* ── TOAST ─────────────────────────────────────────────────────────────── */}
      <Toast toast={toast} />
    </div >
  );
}