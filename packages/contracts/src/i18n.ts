/** Bilingual text carried on definitions, instruments and notifications. English is the key; Arabic is the value. */
export interface Bilingual { en: string; ar?: string }
export const SUPPORTED_LANGUAGES = ['en', 'ar'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const RTL_LANGUAGES: readonly Language[] = ['ar'];
export const isRtl = (lang: string): boolean => (RTL_LANGUAGES as readonly string[]).includes(lang);
export const pick = (b: Bilingual | string | null | undefined, lang: Language = 'en'): string => {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  return (lang === 'ar' && b.ar) || b.en;
};
