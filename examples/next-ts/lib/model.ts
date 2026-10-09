export function existingGeneration(signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const chunks = ["This local stream stands in for ", "your existing generation response."];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal.aborted) { controller.error(signal.reason); return; }
      if (index === chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
    cancel() {}
  }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
