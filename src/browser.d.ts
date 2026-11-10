/** Resolve after the publisher has presented the result; After timing starts then. */
export type GenerationConsumer<T> = (response: Response, lifecycle: {
  /** Streaming output progress. For Before and During Image, call after the first result is presented. */
  onDelta(): void;
  /** Explicitly mark the result as presented. Idempotent and bound to this generation. */
  onPresented(): void;
}) => T | Promise<T>;
export type PublisherAds<Bound extends boolean = boolean> = {
  ready: Promise<void>;
  connectGeneration<T>(options: { request: (headers: Record<string, string>) => Response | Promise<Response>; consume: GenerationConsumer<T>; signal?: AbortSignal }): Promise<T>;
  setConversation(binding: Bound extends true
    ? { userId: string; conversationId: string; sessionId: string }
    : { userId: string; conversationId: string; sessionId?: string }): void;
  dispose(): void;
  openPrivacySettings(): void;
  grant(choice?: unknown): Promise<unknown>;
  deny(): Promise<unknown>;
  withdraw(): Promise<unknown>;
};
export type PublisherConsentTheme = {
  /** Six-digit hex colors. Insufficient contrast falls back to readable colors. */
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  /** Font family names only, without CSS rules or URLs. No font is downloaded. */
  fontFamily?: string;
  /** Corner radius in pixels, 0–20. */
  radius?: number;
  /** Card padding in pixels, 12–32. */
  spacing?: number;
};
type PublisherAdsOptionsBase = {
  target: HTMLElement;
  clientId: string;
  surfaceId: string;
  jobType: "chat" | "code" | "image" | "voice" | "agent";
  userId: string;
  conversationId: string;
  timing?: "before" | "during" | "after";
  consentMode?: "wavebird_consent" | "own_cmp";
  /** Defaults to browser language preferences, then English. Optional BCP 47 language tag or "auto". */
  consentLocale?: string;
  /** Presentation only. Does not change consent choices or storage. */
  consentTheme?: PublisherConsentTheme;
  /** Optional official renderer URL. Only https://api.wavebird.ai/v1/render.js is supported. */
  rendererUrl?: string;
  privacySettingsTarget?: string;
  getFormat?: () => "banner" | "native" | "clip" | "auto";
  /** Fixed diagnostic codes only. Exceptions in this callback never interrupt the model. */
  onDiagnostic?: (event: { code: "renderer_csp_blocked" | "renderer_unavailable" | "renderer_frame_unavailable" }) => void;
  placementEndpoint?: string;
  consentEndpoint?: string;
};
export function createPublisherAds(options: PublisherAdsOptionsBase &
  { turnBinding?: false; sessionId?: string }): PublisherAds<false>;
/** Opt-in successor: a trusted host session is required at mount and at each conversation change. */
export function createPublisherAds(options: PublisherAdsOptionsBase &
  { turnBinding: true; sessionId: string }): PublisherAds<true>;
/** Pass the mount's ads instance to keep concurrent surfaces bound to their own generation. */
export function connectPublisherGeneration<T>(url: string, init: RequestInit, consume: GenerationConsumer<T>, ads?: PublisherAds): Promise<T>;
