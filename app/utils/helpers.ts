// ─── UTILITY FUNCTIONS ────────────────────────────────────────────────────────

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

export const getEmail = (m: any) => (m && typeof m === "object" ? m.email : m) as string;

export const getIsAdmin = (m: any) => !!(m && typeof m === "object" && m.is_admin);

export const safeParseJSON = <T,>(str: string | null, fallback: T): T => {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
};

export const fmtDuration = (sec: number) => {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export const parseTs = (ts: string): Date => {
  if (!ts) return new Date();
  let clean = ts.replace(" ", "T");
  const hasOffset = clean.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(clean);
  if (!hasOffset) clean += "Z";
  clean = clean.replace(/\.(\d{3})\d+/, ".$1");
  const d = new Date(clean);
  return isNaN(d.getTime()) ? (new Date(ts) || new Date()) : d;
};

export const formatTimeAgo = (ts: number): string => {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

export const updateReactionsForUser = (
  reactions: Record<string, string[]> | undefined,
  user: string,
  emoji: string,
): Record<string, string[]> => {
  const current = reactions || {};
  const next: Record<string, string[]> = {};
  let wasReactedWithSame = false;

  Object.entries(current).forEach(([em, users]) => {
    const filtered = users.filter(u => u !== user);
    if (em === emoji) {
      if (users.includes(user)) wasReactedWithSame = true;
      else filtered.push(user);
    }
    if (filtered.length > 0) next[em] = filtered;
  });

  if (!wasReactedWithSame && !next[emoji]) next[emoji] = [user];
  return next;
};
