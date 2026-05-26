export type StickerPackMeta = { id: number; name: string; thumbnail_url: string };
export type StickerItem = { id: number; url: string; name: string };
export type Chat = { type: "user" | "group"; id: string | number; name: string };
export type Contact = {
  email: string; username?: string | null; display_name?: string | null;
  nickname?: string | null; is_online?: boolean; avatar_url?: string | null;
};
export type Group = { id: string | number; name: string; members: any[]; avatar_url?: string | null; description?: string | null };
export type Message = {
  id: string | number; user: string; content: string; timestamp: string;
  group_id?: string | number; group_name?: string; receiver_email?: string;
  target_user?: string; is_read?: boolean; is_deleted?: boolean;
  edited_at?: string; reply_to_id?: string | number; reply_to_content?: string;
  reactions?: Record<string, string[]>; read_by?: string[];
  sender_name?: string; sender_avatar?: string; _callRecord?: boolean;
  is_forwarded?: boolean; forwarded_from_id?: string | number;
};
export type GroupedMessage = { type: "divider"; label: string } | ({ type: "msg" } & Message);
export type CallState = "idle" | "incoming" | "calling" | "connected";
export type ApiOptions = RequestInit & { headers?: HeadersInit; signal?: AbortSignal };
export type AuthStep = "signin" | "signup" | "pick-username" | "verify-email" | "forgot-password" | "reset-password";
export type CallLogEntry = {
  id: string; peer: string; peerName: string;
  direction: "incoming" | "outgoing"; media: "audio" | "video";
  status: "completed" | "missed" | "rejected"; timestamp: string; duration: number;
};
export type WsStatus = "connected" | "disconnected" | "reconnecting" | "offline";
export type ProfileTab = "info" | "media" | "calls" | "members";
export type StoredCallOffer = {
  sdp: RTCSessionDescriptionInit; peer: string; peerName: string;
  isVideo: boolean; ts: number; group_id?: string | number;
};

export type AuthState = {
  step: AuthStep; email: string; pass: string; pass2: string;
  user: string; loading: boolean; error: string;
};
export type AuthAction =
  | { type: "SET_STEP"; step: AuthStep }
  | { type: "SET_FIELD"; field: "email" | "pass" | "pass2" | "user"; value: string }
  | { type: "SET_LOADING"; value: boolean }
  | { type: "SET_ERROR"; value: string }
  | { type: "RESET" };
