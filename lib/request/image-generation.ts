import type { RequestBody } from "../types.js";

export const IMAGE_GENERATION_TOOL = {
	type: "image_generation",
	output_format: "png",
} as const;

export function ensureImageGenerationTool(body: RequestBody): RequestBody {
	const existing = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
	const hasImageGen = existing.some(
		(t) => typeof t === "object" && t !== null && (t as { type?: string }).type === "image_generation",
	);
	if (hasImageGen) return body;
	return { ...body, tools: [...existing, IMAGE_GENERATION_TOOL] };
}
