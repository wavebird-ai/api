import { publisher } from "../../../lib/publisher.js";
import { existingGeneration } from "../../../lib/model.js";

export async function POST(request) {
  return publisher.withGeneration({ request, run: existingGeneration });
}
