/** Resolve after the publisher has presented the result; After timing starts then. */
export type GenerationConsumer<T> = (response: Response, lifecycle: { onDelta(): void }) => T | Promise<T>;
export type PublisherAds = {
  ready: Promise<void>;
  connectGeneration<T>(options: { request: (headers: Record<string, string>) => Response | Promise<Response>; consume: GenerationConsumer<T>; signal?: AbortSignal }): Promise<T>;
  setConversation(binding: { userId: string; conversationId: string; sessionId?: string }): void;
  dispose(): void;
  openPrivacySettings(): void;
  grant(choice?: unknown): Promise<unknown>;
  deny(): Promise<unknown>;
  withdraw(): Promise<unknown>;
};
type PublisherAdsOptions = {
  target: HTMLElement;
  clientId: string;
  surfaceId: string;
  jobType: "chat" | "code" | "image" | "voice" | "agent";
  userId: string;
  conversationId: string;
  timing?: "before" | "during" | "after";
  consentMode?: "wavebird_consent" | "own_cmp";
  /** Optional official renderer URL. Only https://api.wavebird.ai/v1/render.js is supported. */
  rendererUrl?: string;
  privacySettingsTarget?: string;
  getFormat?: () => "banner" | "native" | "clip" | "auto";
  placementEndpoint?: string;
  consentEndpoint?: string;
} & (
  { turnBinding?: false; sessionId?: string } |
  /** Opt-in successor contract: a session ID supplied by the host's authenticated context. */
  { turnBinding: true; sessionId: string }
);
export function createPublisherAds(options: PublisherAdsOptions): PublisherAds;
/** Pass the mount's ads instance to keep concurrent surfaces bound to their own generation. */
export function connectPublisherGeneration<T>(url: string, init: RequestInit, consume: GenerationConsumer<T>, ads?: PublisherAds): Promise<T>;
