// lib/updater.ts
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://pratik0165-pulsebackend.hf.space";

export async function initOTAUpdater(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  // Tell Capgo the current bundle loaded successfully.
  // Must be called on every launch — if a new bundle crashes before calling this,
  // Capgo auto-rolls back to the previous good bundle.
  try {
    await CapacitorUpdater.notifyAppReady();
  } catch (e) {
    console.warn("[OTA] notifyAppReady failed:", e);
    return;
  }

  try {
    const res = await fetch(`${API_URL}/updates/latest`, {
      headers: { "Cache-Control": "no-cache, no-store" },
    });
    if (!res.ok) return;

    const latest: { version: string; url: string; checksum: string } = await res.json();

    // Server returns empty url when no bundle has been deployed yet
    if (!latest?.url || !latest?.version) return;

    const { bundle: current } = await CapacitorUpdater.current();
    const currentVersion = current?.version ?? "builtin";

    console.log(`[OTA] current=${currentVersion}  server=${latest.version}`);
    if (currentVersion === latest.version) return;

    console.log(`[OTA] Downloading v${latest.version} from ${latest.url}`);
    const bundle = await CapacitorUpdater.download({
      url: latest.url,
      version: latest.version,
      // checksum is verified by Capgo automatically when provided
    });
    console.log(`[OTA] Download done — bundle id=${bundle.id}`);

    // Apply when the user next backgrounds the app so there's no visible interruption
    const { remove } = await App.addListener("appStateChange", async ({ isActive }) => {
      if (isActive) return;
      remove();               // unregister so we only fire once
      try {
        console.log(`[OTA] Applying bundle ${bundle.id}`);
        await CapacitorUpdater.set({ id: bundle.id });
        // The app restarts here — code below does not run
      } catch (err) {
        console.warn("[OTA] set() failed:", err);
        await CapacitorUpdater.delete({ id: bundle.id }).catch(() => { });
      }
    });
  } catch (err) {
    console.warn("[OTA] Update check failed (non-fatal):", err);
  }
}