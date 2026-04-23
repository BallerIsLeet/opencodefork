import { describe, it, expect } from 'vitest';
import { ensureImageGenerationTool, IMAGE_GENERATION_TOOL } from '../lib/request/image-generation.js';
import type { RequestBody } from '../lib/types.js';

describe('ensureImageGenerationTool', () => {
	it('adds the tool when tools is undefined', () => {
		const body: RequestBody = { model: 'gpt-5.2' };
		const result = ensureImageGenerationTool(body);
		expect(result.tools).toEqual([IMAGE_GENERATION_TOOL]);
	});

	it('adds the tool when tools is an empty array', () => {
		const body: RequestBody = { model: 'gpt-5.2', tools: [] };
		const result = ensureImageGenerationTool(body);
		expect(result.tools).toEqual([IMAGE_GENERATION_TOOL]);
	});

	it('appends alongside other tools', () => {
		const otherTool = { type: 'function', name: 'lookup' };
		const body: RequestBody = { model: 'gpt-5.2', tools: [otherTool] };
		const result = ensureImageGenerationTool(body);
		expect(result.tools).toEqual([otherTool, IMAGE_GENERATION_TOOL]);
	});

	it('leaves the body unchanged when image_generation is already present', () => {
		const customImageTool = { type: 'image_generation', output_format: 'jpeg' };
		const body: RequestBody = { model: 'gpt-5.2', tools: [customImageTool] };
		const result = ensureImageGenerationTool(body);
		expect(result.tools).toEqual([customImageTool]);
	});

	it('does not mutate the input body', () => {
		const body: RequestBody = { model: 'gpt-5.2' };
		ensureImageGenerationTool(body);
		expect(body.tools).toBeUndefined();
	});

	it('does not mutate the input tools array', () => {
		const tools: unknown[] = [{ type: 'function', name: 'lookup' }];
		const body: RequestBody = { model: 'gpt-5.2', tools };
		ensureImageGenerationTool(body);
		expect(tools).toHaveLength(1);
	});

	it('treats non-array tools values as missing and appends', () => {
		const body = { model: 'gpt-5.2', tools: 'not-an-array' } as unknown as RequestBody;
		const result = ensureImageGenerationTool(body);
		expect(result.tools).toEqual([IMAGE_GENERATION_TOOL]);
	});
});
