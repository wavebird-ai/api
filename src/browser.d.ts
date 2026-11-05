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
type PublisherAdsOptionsBase = {
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
};
export function createPublisherAds(options: PublisherAdsOptionsBase &
  { turnBinding?: false; sessionId?: string }): PublisherAds<false>;
/** Opt-in successor: a trusted host session is required at mount and at each conversation change. */
export function createPublisherAds(options: PublisherAdsOptionsBase &
  { turnBinding: true; sessionId: string }): PublisherAds<true>;
/** Pass the mount's ads instance to keep concurrent surfaces bound to their own generation. */
export function connectPublisherGeneration<T>(url: string, init: RequestInit, consume: GenerationConsumer<T>, ads?: PublisherAds): Promise<T>;
