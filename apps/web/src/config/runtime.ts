/* Jurisdiction profile — currency, tax and locale conventions come from the platform (GET /jurisdiction),
 * so the same build serves any administration. Defaults cover the first paint before the profile loads. */
import { useSyncExternalStore } from 'react';

export interface Profile {
  code: string; name: string; authority: string; regulatorNote?: string;
  currency: { code: string; symbol: string; locale: string; grouping: 'standard' | 'lakh-crore' };
  tax: { name: string; ratePct: number; registrationLabel: string; invoicePrefix: string };
  pscRegime?: { code: string; name: string };
  identity?: { seafarerIdLabel: string; nationalIdLabel: string; companyIdLabel: string };
  /** Home port geometry for maps and the quay twin. */
  portGeo?: { name: string; lat: number; lon: number; zoomKm: number };
  timezone: string; languages: string[];
}
const DEFAULTS: Record<string, Profile> = {
  AE: { code: 'AE', name: 'United Arab Emirates', authority: 'Ministry of Energy and Infrastructure', currency: { code: 'AED', symbol: 'AED', locale: 'en-AE', grouping: 'standard' }, tax: { name: 'VAT', ratePct: 5, registrationLabel: 'TRN', invoicePrefix: 'MAR/INV' }, pscRegime: { code: 'RMOU', name: 'Riyadh MoU' }, identity: { seafarerIdLabel: 'SID', nationalIdLabel: 'Emirates ID', companyIdLabel: 'Trade licence' }, portGeo: { name: 'Khalifa Port', lat: 24.808, lon: 54.643, zoomKm: 25 }, timezone: 'Asia/Dubai', languages: ['en', 'ar'] },
  IN: { code: 'IN', name: 'India', authority: 'Directorate General of Shipping', currency: { code: 'INR', symbol: '₹', locale: 'en-IN', grouping: 'lakh-crore' }, tax: { name: 'GST', ratePct: 18, registrationLabel: 'GSTIN', invoicePrefix: 'REF/INV' }, pscRegime: { code: 'IOMOU', name: 'Indian Ocean MoU' }, identity: { seafarerIdLabel: 'INDoS', nationalIdLabel: 'Aadhaar', companyIdLabel: 'CIN' }, portGeo: { name: 'Reference Port', lat: 22.74, lon: 69.70, zoomKm: 25 }, timezone: 'Asia/Kolkata', languages: ['en'] },
};
let current: Profile = DEFAULTS[(import.meta.env.VITE_PROFILE || 'AE').toUpperCase()] || DEFAULTS.AE;
const listeners = new Set<() => void>();
export const getProfile = () => current;
export function setProfile(p: Partial<Profile> & { code?: string }) {
  const base = DEFAULTS[String(p.code || current.code).toUpperCase()] || current;
  current = { ...base, ...p, currency: { ...base.currency, ...(p.currency || {}) }, tax: { ...base.tax, ...(p.tax || {}) } };
  listeners.forEach((l) => l());
}
export const useProfile = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getProfile, getProfile);
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';
