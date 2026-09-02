import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Session, SessionUser } from '../types';

const KEY = 'maritime-session';
const stored: Session | null = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } })();
const persist = (s: { user: SessionUser | null; token: string | null; refreshToken: string | null }) => { try { if (s.user) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

interface AuthState { user: SessionUser | null; token: string | null; refreshToken: string | null }
const initialState: AuthState = { user: stored?.user || null, token: stored?.token || null, refreshToken: stored?.refreshToken || null };

const slice = createSlice({
  name: 'auth', initialState,
  reducers: {
    setSession(state, { payload }: PayloadAction<Session>) { state.user = payload.user; state.token = payload.token; state.refreshToken = payload.refreshToken; persist(state); },
    updateUser(state, { payload }: PayloadAction<SessionUser>) { state.user = payload; persist(state); },
    clearSession(state) { state.user = null; state.token = null; state.refreshToken = null; persist(state); },
  },
});
export const { setSession, updateUser, clearSession } = slice.actions;
export default slice.reducer;
