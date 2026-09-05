import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Session, SessionMfa, SessionPolicy, SessionUser } from '../types';

const KEY = 'maritime-session';
interface AuthState { user: SessionUser | null; token: string | null; refreshToken: string | null; sessionId: string | null; policy: SessionPolicy | null; mfa: SessionMfa | null }
const stored: Partial<AuthState> | null = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } })();
const persist = (s: AuthState) => { try { if (s.user) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

const initialState: AuthState = { user: stored?.user || null, token: stored?.token || null, refreshToken: stored?.refreshToken || null, sessionId: stored?.sessionId || null, policy: stored?.policy || null, mfa: stored?.mfa || null };

const slice = createSlice({
  name: 'auth', initialState,
  reducers: {
    setSession(state, { payload }: PayloadAction<Session>) {
      state.user = payload.user; state.token = payload.token; state.refreshToken = payload.refreshToken;
      state.sessionId = payload.sessionId ?? state.sessionId; state.policy = payload.policy ?? state.policy; state.mfa = payload.mfa ?? state.mfa;
      persist(state);
    },
    updateUser(state, { payload }: PayloadAction<SessionUser>) { state.user = payload; persist(state); },
    setMfa(state, { payload }: PayloadAction<SessionMfa>) { state.mfa = payload; if (state.user) state.user = { ...state.user, mfa: { ...(state.user.mfa ?? { required: payload.required }), ...payload } }; persist(state); },
    clearSession(state) { state.user = null; state.token = null; state.refreshToken = null; state.sessionId = null; state.policy = null; state.mfa = null; persist(state); },
  },
});
export const { setSession, updateUser, setMfa, clearSession } = slice.actions;
export default slice.reducer;
