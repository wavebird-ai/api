import "server-only";
import { createPublisherServer } from "@wavebirdai/api/server";
import { authorizePublisherRequest } from "./auth.js";

export const publisher = createPublisherServer({
  apiBaseUrl: process.env.WAVEBIRD_API_BASE_URL,
  clientId: process.env.WAVEBIRD_CLIENT_ID,
  secretKey: process.env.WAVEBIRD_SECRET_KEY,
  preferenceSecret: process.env.WAVEBIRD_PREFERENCE_SECRET,
  authorize: authorizePublisherRequest,
  publicOrigins: (process.env.WAVEBIRD_PUBLIC_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
  surfaceId: "chat_assistant",
  placementKey: "default",
  jobType: "chat",
  locale: "en-US",
  timing: "during",
  consentMode: "wavebird_consent",
  gdprApplies: true,
  publisher: { app_name: "Your saved app name", app_domain: "your.example", categories: [] },
  allowedFormats: ["banner"],
  positionHint: "between",
  maxWidth: 728,
  maxHeight: 90,
  allowedSizes: [{ width: 728, height: 90 }]
});
