export type PublisherServerOptions = {
  apiBaseUrl?: string;
  clientId: string;
  secretKey: string;
  preferenceSecret: string;
  authorize: (request: Request) => boolean | Promise<boolean>;
  surfaceId: string;
  placementKey: string;
  jobType: string;
  locale: string;
  timing: "before" | "during" | "after";
  consentMode: "wavebird_consent" | "own_cmp";
  gdprApplies: boolean;
  publisher: { app_name: string; app_domain: string; categories: string[] };
  allowedFormats: Array<"banner" | "native">;
  positionHint: "above" | "below" | "sidebar" | "between";
  maxWidth: number;
  maxHeight: number;
  allowedSizes: Array<{ width: number; height: number }>;
  bidfloor?: number;
  bidfloorCurrency?: string;
  blockedCategories?: string[];
};
export type GenerationLifecycleEvent = {
  type: "started" | "done" | "error" | "abort";
  sessionId: string;
  generationId: string;
};
export type PublisherServer = {
  placementPOST(request: Request): Promise<Response>;
  consentGET(request: Request): Promise<Response>;
  consentPOST(request: Request): Promise<Response>;
  withGeneration(options: { request: Request; run: (signal: AbortSignal) => Response | Promise<Response>; onLifecycle?: (event: GenerationLifecycleEvent) => void | Promise<void> }): Promise<Response>;
  reportGeneration(jobId: string, event: "started" | "finished" | "failed"): Promise<void>;
};
export function createPublisherServer(options: PublisherServerOptions): PublisherServer;
