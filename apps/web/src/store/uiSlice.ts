import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type Mode = 'light' | 'dark';
export type Lang = 'en' | 'ar';
export interface Snack { message: string; severity?: 'success' | 'info' | 'warning' | 'error' }
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

interface UiState { mode: Mode; lang: Lang; snackbar: Snack | null }
const initialState: UiState = { mode: read('maritime-mode') === 'dark' ? 'dark' : 'light', lang: read('maritime-lang') === 'ar' ? 'ar' : 'en', snackbar: null };

const slice = createSlice({
  name: 'ui', initialState,
  reducers: {
    toggleMode(state) { state.mode = state.mode === 'dark' ? 'light' : 'dark'; write('maritime-mode', state.mode); },
    setLang(state, { payload }: PayloadAction<Lang>) { state.lang = payload; write('maritime-lang', payload); },
    notify(state, { payload }: PayloadAction<string | Snack>) { state.snackbar = typeof payload === 'string' ? { message: payload, severity: 'success' } : payload; },
    clearSnackbar(state) { state.snackbar = null; },
  },
});
export const { toggleMode, setLang, notify, clearSnackbar } = slice.actions;
export default slice.reducer;
