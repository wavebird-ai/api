"use client";

import { useEffect, useRef, useState } from "react";
import { createPublisherAds, type PublisherAds } from "@wavebirdai/api/browser";

export default function Page() {
  const slot = useRef<HTMLElement | null>(null);
  const ads = useRef<PublisherAds | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    if (!slot.current) return;
    const target = slot.current;
    const controller = new AbortController();
    let disposed = false;
    let current: PublisherAds | null = null;
    void fetch("/api/sponsor-session", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const sessionId = (await response.json()).session_id;
      if (disposed || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
      current = createPublisherAds({
      target,
      clientId: "wbproj_replace_from_dashboard",
      surfaceId: "chat_assistant",
      jobType: "chat",
      timing: "during",
      consentMode: "wavebird_consent",
      userId: "replace-with-authenticated-user-id",
      conversationId: "replace-with-current-conversation-id",
      sessionId,
      turnBinding: true,
      rendererUrl: "https://api.wavebird.ai/v1/render.js",
      placementEndpoint: "/api/sponsor-slot",
      consentEndpoint: "/api/sponsor-consent",
      privacySettingsTarget: "#privacy-settings"
      });
      ads.current = current;
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); abort.current?.abort(); current?.dispose(); ads.current = null; };
  }, []);
  async function generate() {
    if (!ads.current) return;
    const current = new AbortController();
    abort.current = current;
    setAnswer("");
    try {
      await ads.current.connectGeneration({
        signal: current.signal,
        request: headers => fetch("/api/generate", { method: "POST", headers, signal: current.signal }),
        consume: async (response, lifecycle) => {
          if (!response.ok || !response.body) throw new Error("generation_unavailable");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            setAnswer(value => value + decoder.decode(next.value, { stream: true }));
            lifecycle.onDelta();
          }
        }
      });
    } catch { setAnswer(value => value || "Generation unavailable."); }
  }
  return <main style={{ maxWidth: 760, margin: "2rem auto" }}>
    <h1>Publisher chat</h1>
    <button id="privacy-settings" type="button">Sponsored choices</button>
    <p aria-live="polite">{answer}</p>
    <section ref={slot} aria-label="Sponsored placement area" style={{ width: "100%", maxWidth: 728, height: 346, margin: "1rem auto" }} />
    <div><button type="button" onClick={generate}>Generate</button><button type="button" onClick={() => abort.current?.abort()}>Stop</button></div>
  </main>;
}
