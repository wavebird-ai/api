export type PublisherTurnIdentity = { projectId: string; surfaceId: string; sessionId: string; turnId: string };
/** The successor journal must make claims and phase transitions durable across workers. */
export type PublisherTurnJournal = {
  claimPlacement(turn: PublisherTurnIdentity): Promise<boolean>;
  releaseRejectedPlacement(turn: PublisherTurnIdentity): Promise<void>;
  bind(turn: PublisherTurnIdentity, jobId: string): Promise<void>;
  claimGeneration(turn: PublisherTurnIdentity): Promise<boolean>;
  phase(turn: PublisherTurnIdentity, event: "started" | "finished" | "failed"): Promise<void>;
  reconcilePending?(projectId: string, surfaceId: string): Promise<void>;
};
/** Implement this over an existing serializable, persistent application store. */
export type PublisherAtomicTurnStorage = {
  atomic<T>(scope: string, key: string,
    transition: (previous: unknown | null) => { state: unknown | null; result: T }): Promise<T>;
  /** Return increasing hashed keys after cursor, at most limit. */
  scan(scope: string, cursor: string, limit: number): Promise<string[]>;
  prune?(scope: string): Promise<number>;
};
/** Use an existing pg-compatible pool; run install once in the publisher's normal migration step. */
export function createPostgresTurnStorage(pool: {
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
    release(): void }>;
}): PublisherAtomicTurnStorage & { install(): Promise<void>; prune(scope: string): Promise<number> };
export function createPublisherTurnJournal(options: {
  storage: PublisherAtomicTurnStorage;
  reportGeneration: (jobId: string, event: "started" | "finished" | "failed") => Promise<void>;
  /** Stable server-only secret for pseudonymous durable turn keys, at least 32 UTF-8 bytes. */
  keySecret: string;
  onDiagnostic?: (code: string) => void;
}): PublisherTurnJournal;
/** Derive a stable, domain-separated journal key from the existing server-only preference secret. */
export function derivePublisherTurnKeySecret(preferenceSecret: string): string;
export type PublisherServerOptions = {
  apiBaseUrl?: string;
  clientId: string;
  secretKey: string;
  preferenceSecret: string;
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Opt-in successor: derive the exact browser session from the host's authenticated request. */
  sessionIdForRequest?: (request: Request) => string | null | Promise<string | null>;
  turnJournal?: PublisherTurnJournal;
  onDiagnostic?: (code: string) => void;
  publicOrigins: string[];
  surfaceId: string;
  placementKey: string;
  jobType: string;
  locale: string;
  timing: "before" | "during" | "after";
  consentMode: "wavebird_consent" | "own_cmp";
  gdprApplies: boolean;
  publisher: { app_name: string; app_domain: string; categories: string[] };
  allowedFormats: Array<"banner" | "native" | "clip">;
  positionHint: "above" | "below" | "sidebar" | "between";
  /** Optional advanced caps; saved allowedSizes determine the normal envelope. */
  maxWidth?: number;
  maxHeight?: number;
  allowedSizes: Array<{ width: number; height: number; formats?: Array<"banner" | "native" | "clip"> }>;
  responsiveSizeSelection?: boolean;
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
  sessionGET(request: Request): Promise<Response>;
  placementPOST(request: Request): Promise<Response>;
  consentGET(request: Request): Promise<Response>;
  consentPOST(request: Request): Promise<Response>;
  withGeneration(options: { request: Request; run: (signal: AbortSignal) => Response | Promise<Response>; onLifecycle?: (event: GenerationLifecycleEvent) => void | Promise<void> }): Promise<Response>;
  reportGeneration(jobId: string, event: "started" | "finished" | "failed"): Promise<void>;
};
export function createPublisherServer(options: PublisherServerOptions): PublisherServer;
