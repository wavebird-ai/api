import { getPublisher } from "../../../lib/publisher.js";

export async function GET(request) {
  return getPublisher().sessionGET(request);
}
