import { getPublisher } from "../../../lib/publisher";
import { existingGeneration } from "../../../lib/model";

export async function POST(request: Request): Promise<Response> {
  return getPublisher().withGeneration({ request, run: existingGeneration });
}
