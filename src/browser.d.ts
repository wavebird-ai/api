export type GenerationConsumer<T> = (response: Response, lifecycle: { onDelta(): void }) => T | Promise<T>;
export type PublisherAds = {
  ready: Promise<void>;
  connectGeneration<T>(options: { request: (headers: Record<string, string>) => Response | Promise<Response>; consume: GenerationConsumer<T>; signal?: AbortSignal }): Promise<T>;
  setConversation(binding: { userId: string; conversationId: string }): void;
  dispose(): void;
  openPrivacySettings(): void;
  grant(choice?: unknown): Promise<unknown>;
  deny(): Promise<unknown>;
  withdraw(): Promise<unknown>;
};
export function createPublisherAds(options: {
  target: HTMLElement;
  clientId: string;
  surfaceId: string;
  jobType: string;
  userId: string;
  conversationId: string;
  timing?: "before" | "during" | "after";
  consentMode?: "wavebird_consent" | "own_cmp";
  rendererUrl?: string;
  privacySettingsTarget?: string;
  placementEndpoint?: string;
  consentEndpoint?: string;
}): PublisherAds;
export function connectPublisherGeneration<T>(url: string, init: RequestInit, consume: GenerationConsumer<T>): Promise<T>;
