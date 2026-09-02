import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { store } from '../store';
import { setSession, clearSession } from '../store/authSlice';
import { busyStart, busyEnd } from './busy';
import type { Envelope } from '../types';

export class ApiError extends Error { status?: number; payload?: unknown; constructor(message: string, status?: number, payload?: unknown) { super(message); this.status = status; this.payload = payload; } }

const raw = axios.create({ baseURL: '/api', timeout: 60_000 });
const quiet = (config?: AxiosRequestConfig) => Boolean((config?.headers as Record<string, unknown> | undefined)?.['X-Quiet']);

raw.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (!quiet(config)) busyStart();
  const { token } = store.getState().auth;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<{ data: Envelope<{ user: unknown; token: string; refreshToken: string }> }> | null = null;
raw.interceptors.response.use(
  (res) => { if (!quiet(res.config)) busyEnd(); return res.data; },
  async (err) => {
    if (!quiet(err.config)) busyEnd();
    const original = err.config as InternalAxiosRequestConfig & { _retried?: boolean };
    const status: number | undefined = err.response?.status;
    if (status === 401 && original && !original._retried && !String(original.url).includes('/auth/')) {
      original._retried = true;
      const { refreshToken } = store.getState().auth;
      if (refreshToken) {
        try {
          refreshing = refreshing || axios.post('/api/auth/refresh', { refreshToken });
          const { data } = await refreshing;
          refreshing = null;
          store.dispatch(setSession(data.data as never));
          original.headers.Authorization = `Bearer ${data.data.token}`;
          return raw(original);
        } catch { refreshing = null; store.dispatch(clearSession()); }
      } else store.dispatch(clearSession());
    }
    const message = err.response?.data?.message || err.message || 'Request failed';
    return Promise.reject(new ApiError(message, status, err.response?.data));
  },
);

/** Typed façade: every call resolves to the API envelope `{ success, data, meta }`. */
const api = {
  get: <T = unknown>(url: string, config?: AxiosRequestConfig) => raw.get(url, config) as unknown as Promise<Envelope<T>>,
  post: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => raw.post(url, body, config) as unknown as Promise<Envelope<T>>,
  put: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => raw.put(url, body, config) as unknown as Promise<Envelope<T>>,
  patch: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => raw.patch(url, body, config) as unknown as Promise<Envelope<T>>,
  delete: <T = unknown>(url: string, config?: AxiosRequestConfig) => raw.delete(url, config) as unknown as Promise<Envelope<T>>,
};
export default api;
