import "server-only";

/** Replace this fail-closed stub with createPostgresTurnStorage(your existing pg pool). */
export function publisherTurnStorage() {
  return {
    async atomic() { throw new Error("Connect your existing durable turn store"); },
    async scan() { throw new Error("Connect your existing durable turn store"); },
  };
}
