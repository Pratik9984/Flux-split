"use client";

import React from "react";
import type { AuthState, AuthAction } from "@/app/types";

interface AuthScreenProps {
  auth: AuthState;
  dispatchAuth: React.Dispatch<AuthAction>;
  handleSignIn: () => Promise<void>;
  handleSignUp: () => Promise<void>;
  handleRegister: () => Promise<void>;
  handleForgotPassword: () => Promise<void>;
  handleResetPassword: () => Promise<void>;
  checkUsernameAvailability: (username: string) => void;
}

export function AuthScreen({
  auth,
  dispatchAuth,
  handleSignIn,
  handleSignUp,
  handleRegister,
  handleForgotPassword,
  handleResetPassword,
  checkUsernameAvailability,
}: AuthScreenProps) {
  return (
    <div className="auth-screen">
      <div className="auth-glow auth-glow-1" /><div className="auth-glow auth-glow-2" />
      <div className="auth-left">
        <div className="brand">
          <div className="brand-icon" style={{ overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src="/icon.png" alt="Flux" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <span>Flux</span>
        </div>
        <div className="auth-hero">
          <h1>Connect.<br />Fast.<br /><em>Alive.</em></h1>
          <p>Keep your conversations flowing with real-time speed and end-to-end clarity.</p>
        </div>
        <div className="auth-pills">
          <span className="a-pill a-pill--primary">⚡ Real-time</span>
          <span className="a-pill">💬 Encrypted</span>
          <span className="a-pill">📹 Video calls</span>
        </div>
      </div>

      <div className="auth-right">
        <div className="auth-card">
          {auth.step === "verify-email" && (
            <>
              <div style={{ fontSize: 40, textAlign: "center", marginBottom: 12 }}>📬</div>
              <h2 className="ac-title">Check your inbox</h2>
              <p className="ac-sub">We sent a link to <strong>{auth.email}</strong>.<br />Click it, then come back and sign in.</p>
              <button className="ac-btn" onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })}>Back to sign in</button>
            </>
          )}

          {auth.step === "signin" && (
            <>
              <h2 className="ac-title">Welcome back</h2>
              <p className="ac-sub">Sign in to your Flux account</p>
              {[
                { label: "Email", field: "email" as const, type: "email", placeholder: "you@example.com", icon: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></> },
                { label: "Password", field: "pass" as const, type: "password", placeholder: "••••••••", icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></> }
              ].map(({ label, field, type, placeholder, icon }) => (
                <div key={field} className="ac-field">
                  <label>{label}</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{icon}</svg>
                    <input value={auth[field]} onChange={e => dispatchAuth({ type: "SET_FIELD", field, value: e.target.value })} onKeyDown={e => e.key === "Enter" && handleSignIn()} type={type} placeholder={placeholder} className="ac-input" />
                  </div>
                </div>
              ))}
              <button disabled={auth.loading} onClick={handleSignIn} className="ac-btn">
                {auth.loading && <span className="spinner" />}
                {auth.loading ? "Signing in…" : "Sign in"}
                {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
              </button>
              <p style={{ textAlign: "center", marginTop: 10 }}>
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "forgot-password" })} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}>Forgot password?</button>
              </p>
              <p className="ac-sub" style={{ marginTop: 6, textAlign: "center" }}>
                No account?{" "}
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signup" })} style={{ background: "none", border: "none", color: "var(--green)", cursor: "pointer", fontWeight: 600 }}>Create one</button>
              </p>
            </>
          )}

          {auth.step === "signup" && (
            <>
              <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })} className="ac-back"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg> Back</button>
              <h2 className="ac-title">Create account</h2>
              <p className="ac-sub">Join Flux — it takes 30 seconds</p>
              {[
                { label: "Email", field: "email" as const, type: "email", placeholder: "you@example.com" },
                { label: "Password", field: "pass" as const, type: "password", placeholder: "At least 6 characters" },
                { label: "Confirm password", field: "pass2" as const, type: "password", placeholder: "••••••••" }
              ].map(({ label, field, type, placeholder }) => (
                <div key={field} className="ac-field">
                  <label>{label}</label>
                  <div className="ac-input-wrap">
                    <svg className="ac-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {field === "email"
                        ? <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></>
                        : <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>}
                    </svg>
                    <input
                      value={auth[field]}
                      onChange={e => dispatchAuth({ type: "SET_FIELD", field, value: e.target.value })}
                      onKeyDown={e => e.key === "Enter" && handleSignUp()}
                      type={type}
                      placeholder={placeholder}
                      className="ac-input"
                    />
                  </div>
                </div>
              ))}
              <button disabled={auth.loading} onClick={handleSignUp} className="ac-btn">
                {auth.loading && <span className="spinner" />}
                {auth.loading ? "Creating account…" : "Continue"}
                {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
              </button>
              <p className="ac-sub" style={{ marginTop: 6, textAlign: "center" }}>
                Have an account?{" "}
                <button onClick={() => dispatchAuth({ type: "SET_STEP", step: "signin" })} style={{ background: "none", border: "none", color: "var(--green)", cursor: "pointer", fontWeight: 600 }}>Sign in</button>
              </p>
            </>
          )}

          {auth.step === "pick-username" && (
            <>
              <div style={{ fontSize: 36, textAlign: "center", marginBottom: 8 }}>🏷️</div>
              <h2 className="ac-title">Pick a username</h2>
              <p className="ac-sub">Your unique handle. Lowercase letters, numbers, underscores (3–30 chars).</p>
              <div className="ac-field">
                <label>Username</label>
                <div className="ac-input-wrap">
                  <span className="ac-icon" style={{ fontWeight: 700, color: "var(--text-3)", fontSize: 14 }}>@</span>
                  <input
                    value={auth.user}
                    onChange={e => {
                      const v = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
                      dispatchAuth({ type: "SET_FIELD", field: "user", value: v });
                      dispatchAuth({ type: "SET_ERROR", value: "" });
                      checkUsernameAvailability(v);
                    }}
                    onKeyDown={e => e.key === "Enter" && handleRegister()}
                    type="text"
                    placeholder="e.g. john_doe"
                    className="ac-input"
                    maxLength={30}
                  />
                </div>
                {auth.user.length >= 3 && !auth.error && (
                  <p style={{ fontSize: 12, color: "var(--success)", marginTop: 4 }}>✓ Available</p>
                )}
              </div>
              <button disabled={auth.loading || !!auth.error || auth.user.length < 3} onClick={handleRegister} className="ac-btn">
                {auth.loading && <span className="spinner" />}
                {auth.loading ? "Setting up…" : "Finish setup"}
                {!auth.loading && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
              </button>
            </>
          )}

          {auth.step === "forgot-password" && (
            <>
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
            </>
          )}

          {auth.step === "reset-password" && (
            <>
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
            </>
          )}

          {auth.error && (
            <div className="ac-error">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              {auth.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
