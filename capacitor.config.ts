// capacitor.config.ts
import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.yourapp.flux",           // ← change to your real bundle ID
  appName: "Flux",
  webDir: "out",                        // Next.js static export dir
  plugins: {
    CapacitorUpdater: {
      // Auto-rollback if notifyAppReady() isn't called within 10 seconds of launch
      appReadyTimeout: 10000,
      // Keep the 2 most recent bundles so rollback is instant
      keepUrlPathAfterReload: true,
    },
  },
};

export default config;