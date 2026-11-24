/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_HUB_HOST?: string;
  readonly VITE_HUB_PORT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
