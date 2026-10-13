import { getPublisher } from "../../../lib/publisher.js";
import { existingGeneration } from "../../../lib/model.js";

export async function POST(request) {
  return getPublisher().withGeneration({ request, run: existingGeneration });
}
