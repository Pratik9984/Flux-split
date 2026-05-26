import type { AuthState, AuthAction } from "@/app/types";

// ─── AUTH REDUCER ─────────────────────────────────────────────────────────────
export const authInit: AuthState = { step: "signin", email: "", pass: "", pass2: "", user: "", loading: false, error: "" };

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "SET_STEP": return { ...state, step: action.step, error: "" };
    case "SET_FIELD": return { ...state, [action.field]: action.value };
    case "SET_LOADING": return { ...state, loading: action.value };
    case "SET_ERROR": return { ...state, error: action.value, loading: false };
    case "RESET": return authInit;
    default: return state;
  }
}
