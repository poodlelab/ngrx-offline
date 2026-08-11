export interface ShowcaseRuntimeConfig {
  readonly apiBaseUrl: string;
}

declare global {
  interface Window {
    __NGRX_OFFLINE_CONFIG__?: Partial<ShowcaseRuntimeConfig>;
  }
}

export const showcaseRuntimeConfig: ShowcaseRuntimeConfig = {
  apiBaseUrl:
    globalThis.window?.__NGRX_OFFLINE_CONFIG__?.apiBaseUrl?.replace(/\/$/, '') ??
    `http://${globalThis.location?.hostname ?? 'localhost'}:8787`,
};
