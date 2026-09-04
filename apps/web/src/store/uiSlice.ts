import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type Mode = 'light' | 'dark';
export type Lang = 'en' | 'ar';
export interface Snack { message: string; severity?: 'success' | 'info' | 'warning' | 'error' }
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

interface UiState { mode: Mode; lang: Lang; navCollapsed: boolean; snackbar: Snack | null }

/* Stored preferences are normalised on the way in. localStorage is keyed by origin, so a value left
 * by an older build — or edited by hand — can be anything at all, and it must never reach the theme
 * or the layout as something they cannot render. Exported because initialState is computed once at
 * module load and so cannot be re-evaluated from a test. */
export const storedMode = (): Mode => (read('maritime-mode') === 'dark' ? 'dark' : 'light');
export const storedLang = (): Lang => (read('maritime-lang') === 'ar' ? 'ar' : 'en');
export const storedNavCollapsed = (): boolean => read('maritime-nav') === 'collapsed';

const initialState: UiState = { mode: storedMode(), lang: storedLang(), navCollapsed: storedNavCollapsed(), snackbar: null };

const slice = createSlice({
  name: 'ui', initialState,
  reducers: {
    toggleMode(state) { state.mode = state.mode === 'dark' ? 'light' : 'dark'; write('maritime-mode', state.mode); },
    setLang(state, { payload }: PayloadAction<Lang>) { state.lang = payload; write('maritime-lang', payload); },
    toggleNav(state) { state.navCollapsed = !state.navCollapsed; write('maritime-nav', state.navCollapsed ? 'collapsed' : 'expanded'); },
    setNavCollapsed(state, { payload }: PayloadAction<boolean>) { state.navCollapsed = payload; write('maritime-nav', payload ? 'collapsed' : 'expanded'); },
    notify(state, { payload }: PayloadAction<string | Snack>) { state.snackbar = typeof payload === 'string' ? { message: payload, severity: 'success' } : payload; },
    clearSnackbar(state) { state.snackbar = null; },
  },
});
export const { toggleMode, setLang, toggleNav, setNavCollapsed, notify, clearSnackbar } = slice.actions;
export default slice.reducer;
