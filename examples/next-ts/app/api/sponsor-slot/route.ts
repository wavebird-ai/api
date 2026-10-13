import { getPublisher } from "../../../lib/publisher";

export const POST = (request: Request): Promise<Response> => getPublisher().placementPOST(request);
