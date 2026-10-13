import { getPublisher } from "../../../lib/publisher.js";

export const GET = (request) => getPublisher().consentGET(request);
export const POST = (request) => getPublisher().consentPOST(request);
