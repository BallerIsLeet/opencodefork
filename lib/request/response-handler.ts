import { logRequest, LOGGING_ENABLED } from "../logger.js";

/**
 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(sseText: string): unknown | null {
	const lines = sseText.split('\n');

	// The Codex CLI subscription backend (chatgpt.com/backend-api/codex/responses)
	// has a quirk: its terminal `response.completed` event frequently ships with
	// an empty `output` array even though the stream actually emitted fully
	// populated items (including reasoning + function_call with arguments) via
	// `response.output_item.done`. Walk the stream once, collect the done items,
	// and backfill `response.output` from them if the completed event is empty.
	const doneItems: any[] = [];
	let finalResponse: any = null;

	for (const line of lines) {
		if (!line.startsWith('data: ')) continue;
		let data: any;
		try {
			data = JSON.parse(line.substring(6));
		} catch {
			continue;
		}

		const t = typeof data?.type === 'string' ? data.type : '';

		if (t === 'response.output_item.done' && data.item) {
			doneItems.push(data.item);
			continue;
		}

		if (t === 'response.completed' || t === 'response.done') {
			finalResponse = data.response ?? finalResponse;
		}
	}

	const finalOutputLen = Array.isArray(finalResponse?.output)
		? finalResponse.output.length
		: -1;

	if (finalResponse && finalOutputLen <= 0 && doneItems.length > 0) {
		console.error(
			'[openai-codex-plugin][parseSseStream] backfilling empty response.output with',
			doneItems.length,
			'items collected from output_item.done events',
		);
		finalResponse.output = doneItems;
	}

	// Edge case: no `response.completed` event at all but the stream carried
	// items — synthesize a minimal response so the caller still sees them.
	if (!finalResponse && doneItems.length > 0) {
		console.error(
			'[openai-codex-plugin][parseSseStream] no response.completed event; synthesizing response from',
			doneItems.length,
			'collected items',
		);
		return { output: doneItems };
	}

	return finalResponse ?? null;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export async function convertSseToJson(response: Response, headers: Headers): Promise<Response> {
	if (!response.body) {
		throw new Error('[openai-codex-plugin] Response has no body');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response
		const finalResponse = parseSseStream(fullText);

		if (!finalResponse) {
			console.error('[openai-codex-plugin] Could not find final response in SSE stream');
			logRequest("stream-error", { error: "No response.done event found" });

			// Return original stream if we can't parse
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		console.error('[openai-codex-plugin] Error converting stream:', error);
		logRequest("stream-error", { error: String(error) });
		throw error;
	}
}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}
