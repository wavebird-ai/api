"use client";

import { useEffect, useRef } from "react";
import { createPublisherAds } from "@wavebirdai/api/browser";

export function WavebirdPlacement({ clientId, userId, conversationId, onReady }) {
  const target = useRef(null);
  useEffect(() => {
    if (!target.current || !clientId || !userId || !conversationId) return;
    const controller = new AbortController();
    let disposed = false;
    let ads = null;
    void fetch("/api/sponsor-session", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const sessionId = (await response.json()).session_id;
      if (disposed || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
      ads = createPublisherAds({
      target: target.current,
      clientId,
      surfaceId: "chat_assistant",
      jobType: "chat",
      timing: "during",
      consentMode: "wavebird_consent",
      userId,
      conversationId,
      sessionId,
      turnBinding: true,
      rendererUrl: "https://api.wavebird.ai/v1/render.js",
      placementEndpoint: "/api/sponsor-slot",
      consentEndpoint: "/api/sponsor-consent",
      privacySettingsTarget: "#wavebird-privacy-settings"
      });
      onReady?.(ads);
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); onReady?.(null); ads?.dispose(); };
  }, [clientId, userId, conversationId, onReady]);
  return <>
    <button id="wavebird-privacy-settings" type="button">Sponsored choices</button>
    <section ref={target} aria-label="Sponsored placement area" style={{ width: "100%", maxWidth: 728, height: 346 }} />
  </>;
}
