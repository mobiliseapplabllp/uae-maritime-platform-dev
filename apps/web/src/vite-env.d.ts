/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_DEMO?: string; readonly VITE_AI_PORTAL_URL?: string; readonly VITE_PROFILE?: string; readonly VITE_GATEWAY_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
