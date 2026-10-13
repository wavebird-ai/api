import { getPublisher } from "../../../lib/publisher.js";

export const POST = (request) => getPublisher().placementPOST(request);
