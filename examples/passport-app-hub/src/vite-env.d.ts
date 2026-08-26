/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Raw URL of the app registry's `registry.json` (for example the GitHub raw
   * URL once the registry repository is public). When set, the hub fetches it
   * on load so the list updates without a rebuild; when unset or unreachable,
   * the bundled snapshot is shown instead.
   */
  readonly VITE_REGISTRY_JSON_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
