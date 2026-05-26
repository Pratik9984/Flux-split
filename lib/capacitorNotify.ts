import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const IS_NATIVE = Capacitor.isNativePlatform();
const CALL_NOTIF_ID = 999; // must match Java CALL_NOTIF_ID

export async function requestNotifyPermission() {
    if (!IS_NATIVE) {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            await Notification.requestPermission();
        }
        return;
    }
    try {
        await LocalNotifications.requestPermissions();
        // Register Accept / Decline action buttons shown in the notification shade
        await LocalNotifications.registerActionTypes({
            types: [
                {
                    id: "CALL_ACTIONS",
                    actions: [
                        { id: "ACCEPT_CALL", title: "✅ Accept", foreground: true },
                        { id: "DECLINE_CALL", title: "❌ Decline", foreground: false, destructive: true },
                    ],
                },
            ],
        });
    } catch (e) {
        console.warn("Notification permission failed", e);
    }
}

export async function showLocalNotification(title: string, body: string, chatId?: string) {
    if (!IS_NATIVE) {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(title, { body });
        }
        return;
    }
    try {
        await LocalNotifications.schedule({
            notifications: [{
                id: Math.floor(Math.random() * 900_000) + 1,
                title,
                body,
                channelId: "flux_messages_v2",
                actionTypeId: "",
                extra: { type: "message", chatId: chatId || "" },
            }],
        });
    } catch (e) {
        console.warn("showLocalNotification failed", e);
    }
}

export async function showCallNotification(title: string, body: string, offerJson = "") {
    if (IS_NATIVE) {
        // Route through the Java service so the notification is properly ongoing
        try {
            const FluxNative = (await import("@capacitor/core")).registerPlugin<any>("FluxNative");
            await FluxNative.showCallNotif({
                caller: body.replace(" is calling…", ""),
                isVideo: title.includes("Video"),
                offerData: offerJson,
            });
        } catch (e) { console.warn("showCallNotification (native) failed", e); }
        return;
    }
    // Web fallback
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body, requireInteraction: true } as NotificationOptions);
    }
}

export async function cancelCallNotification() {
    if (!IS_NATIVE) return;
    try {
        await LocalNotifications.cancel({ notifications: [{ id: CALL_NOTIF_ID }] });
    } catch { }
}