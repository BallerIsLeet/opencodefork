import { logRequest, LOGGING_ENABLED } from "../logger.js";

/**
 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(sseText: string): unknown | null {
	const lines = sseText.split('\n');

	// --- DIAGNOSTIC INSTRUMENTATION ---
	// Walk the entire stream first so we can report what was actually emitted
	// before deciding what to return. This is a debugging aid for the
	// "output:[] but output_tokens > 0" case.
	const eventTypeCounts: Record<string, number> = {};
	const collectedItems: any[] = [];
	let finalResponse: any = null;

	for (const line of lines) {
		if (!line.startsWith('data: ')) continue;
		let data: any;
		try {
			data = JSON.parse(line.substring(6));
		} catch {
			continue;
		}

		const t = typeof data?.type === 'string' ? data.type : '<no-type>';
		eventTypeCounts[t] = (eventTypeCounts[t] ?? 0) + 1;

		if (t === 'response.output_item.done' && data.item) {
			collectedItems.push(data.item);
		}

		if (t === 'response.completed' || t === 'response.done') {
			finalResponse = data.response ?? finalResponse;
		}
	}

	const finalOutputLen = Array.isArray(finalResponse?.output)
		? finalResponse.output.length
		: -1;
	const collectedSummary = collectedItems.map((it: any) => ({
		type: it?.type,
		name: it?.name,
		hasContent: Array.isArray(it?.content) ? it.content.length : undefined,
	}));

	console.error(
		'[openai-codex-plugin][parseSseStream] event types:',
		JSON.stringify(eventTypeCounts),
		'| final.output.length:',
		finalOutputLen,
		'| collected items from output_item.done:',
		JSON.stringify(collectedSummary),
	);

	// If the final response had no output items but the stream actually emitted
	// some via response.output_item.done, dump them so we can see what they were.
	if (finalOutputLen <= 0 && collectedItems.length > 0) {
		console.error(
			'[openai-codex-plugin][parseSseStream] WARNING: response.completed had empty output but stream contained items. First item:',
			JSON.stringify(collectedItems[0]).slice(0, 1000),
		);
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
