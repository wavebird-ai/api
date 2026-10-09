import { publisher } from "../../../lib/publisher";
import { existingGeneration } from "../../../lib/model";

export async function POST(request: Request): Promise<Response> {
  return publisher.withGeneration({ request, run: existingGeneration });
}
