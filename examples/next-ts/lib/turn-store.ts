import "server-only";
import type { PublisherAtomicTurnStorage } from "@wavebirdai/api/server";

/** Replace this fail-closed stub with createPostgresTurnStorage(your existing pg pool). */
export function publisherTurnStorage(): PublisherAtomicTurnStorage {
  return {
    async atomic<T>(): Promise<T> { throw new Error("Connect your existing durable turn store"); },
    async scan(): Promise<string[]> { throw new Error("Connect your existing durable turn store"); },
  };
}
