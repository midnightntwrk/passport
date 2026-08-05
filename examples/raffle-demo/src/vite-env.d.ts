/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PASSPORT_ORIGIN?: string;
  readonly VITE_TELEGRAM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
