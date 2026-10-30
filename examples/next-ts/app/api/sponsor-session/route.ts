import { getPublisher } from "../../../lib/publisher";

export async function GET(request: Request): Promise<Response> {
  return getPublisher().sessionGET(request);
}
