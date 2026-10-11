"use client";

import { useEffect, useRef } from "react";
import { createPublisherAds } from "@wavebirdai/api/browser";

export function WavebirdPlacement({ clientId, userId, conversationId, onReady }) {
  const target = useRef(null);
  useEffect(() => {
    if (!target.current || !clientId || !userId || !conversationId) return;
    const ads = createPublisherAds({
      target: target.current,
      clientId,
      surfaceId: "chat_assistant",
      jobType: "chat",
      timing: "during",
      consentMode: "wavebird_consent",
      userId,
      conversationId,
      rendererUrl: "https://api.wavebird.ai/v1/render.js",
      placementEndpoint: "/api/sponsor-slot",
      consentEndpoint: "/api/sponsor-consent",
      privacySettingsTarget: "#wavebird-privacy-settings"
    });
    onReady?.(ads);
    return () => { onReady?.(null); ads.dispose(); };
  }, [clientId, userId, conversationId, onReady]);
  return <>
    <button id="wavebird-privacy-settings" type="button">Sponsored choices</button>
    <section ref={target} aria-label="Sponsored placement area" style={{ width: "100%", maxWidth: 728, height: 346 }} />
  </>;
}
