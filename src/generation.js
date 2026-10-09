function generationTransport({ request, run }) {
    const sessionId = request.headers.get("x-wavebird-session-id") || "";
    const generationId = request.headers.get("x-wavebird-generation-id") || "";
    const validId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!validId(sessionId) || !validId(generationId))
        return run(request.signal);
    const abort = new AbortController();
    const stop = () => abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted)
        stop();
    let reader = null;
    let pending;
    try {
        pending = Promise.resolve(run(abort.signal));
    }
    catch (error) {
        pending = Promise.reject(error);
    }
    pending.catch(() => { });
    const encoder = new TextEncoder();
    const record = (value) => encoder.encode(JSON.stringify({
        session_id: sessionId, generation_id: generationId, ...value
    }) + "\n");
    async function* records() {
        try {
            if (abort.signal.aborted)
                throw new Error("generation_aborted");
            yield record({ type: "started" });
            const response = await pending;
            if (!(response instanceof Response))
                throw new Error("model_response_required");
            if (abort.signal.aborted)
                throw new Error("generation_aborted");
            const headers = [...response.headers.entries()].filter(([name]) => !["set-cookie", "content-length", "content-encoding", "transfer-encoding"].includes(name.toLowerCase()));
            if (response.headers.has("set-cookie"))
                throw new Error("model_response_cookie_requires_outer_route");
            yield record({ type: "response", status: response.status, status_text: response.statusText, headers });
            reader = response.body?.getReader() || null;
            if (reader) {
                while (true) {
                    if (abort.signal.aborted)
                        throw new Error("generation_aborted");
                    const next = await reader.read();
                    if (abort.signal.aborted)
                        throw new Error("generation_aborted");
                    if (next.done)
                        break;
                    for (let offset = 0; offset < next.value.length; offset += 16384) {
                        yield record({ type: "bytes", data: Buffer.from(next.value.subarray(offset, offset + 16384)).toString("base64") });
                    }
                }
            }
            yield record({ type: response.ok ? "done" : "error" });
        }
        catch {
            yield record({ type: abort.signal.aborted ? "abort" : "error" });
        }
        finally {
            abort.abort();
            if (reader) {
                try {
                    await reader.cancel();
                }
                catch { }
                reader.releaseLock();
            }
            request.signal.removeEventListener("abort", stop);
        }
    }
    const iterator = records();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const next = await iterator.next();
                if (next.done)
                    controller.close();
                else
                    controller.enqueue(next.value);
            }
            catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            abort.abort(reason);
            void reader?.cancel(reason).catch(() => { });
            void iterator.return(undefined).catch(() => { });
        }
    }, { highWaterMark: 1 });
    return new Response(body, { headers: {
            "Content-Type": "application/x-wavebird-generation+jsonl",
            "Cache-Control": "no-store", "X-Wavebird-Generation-Transport": "1"
        } });
}
export { generationTransport };
