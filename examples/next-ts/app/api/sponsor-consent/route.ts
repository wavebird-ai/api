import { getPublisher } from "../../../lib/publisher";

export const GET = (request: Request): Promise<Response> => getPublisher().consentGET(request);
export const POST = (request: Request): Promise<Response> => getPublisher().consentPOST(request);
