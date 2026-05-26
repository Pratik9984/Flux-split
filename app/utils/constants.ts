import { createClient } from "@supabase/supabase-js";
import { Capacitor, registerPlugin } from "@capacitor/core";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

// ─── PLATFORM ─────────────────────────────────────────────────────────────────
export const IS_NATIVE = Capacitor.isNativePlatform();

// ─── NATIVE PLUGIN ────────────────────────────────────────────────────────────
export interface FluxNativePlugin {
  startService(opts: { token: string; wsUrl: string }): Promise<void>;
  stopService(): Promise<void>;
  setForeground(opts: { foreground: boolean }): Promise<void>;
  stopCall(): Promise<void>;
  downloadFile?(opts: { url: string; name: string }): Promise<void>;
}
export const FluxNative = IS_NATIVE ? registerPlugin<FluxNativePlugin>("FluxNative") : null;

// ─── API / WS ─────────────────────────────────────────────────────────────────
export const API = process.env.NEXT_PUBLIC_API_URL || "https://pratik0165-pulsebackend.hf.space";
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || API.replace(/^http/, "ws");
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
