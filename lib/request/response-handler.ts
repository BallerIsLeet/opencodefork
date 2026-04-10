import { logRequest, LOGGING_ENABLED } from "../logger.js";

/**
 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(sseText: string): unknown | null {
	const lines = sseText.split('\n');

	// --- DIAGNOSTIC INSTRUMENTATION (no behavior change) ---
	// Walk the stream once to collect what's actually emitted, then dump enough
	// of the function_call items to know whether their `arguments` field is
	// already populated in `response.output_item.done` or whether we'd need to
	// stitch together `response.function_call_arguments.delta` events.
	const eventTypeCounts: Record<string, number> = {};
	const doneItems: any[] = [];
	const argumentDeltasByItem: Record<string, string> = {};
	const argumentDoneByItem: Record<string, string> = {};
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
			doneItems.push(data.item);
		}

		if (t === 'response.function_call_arguments.delta') {
			const id = String(data?.item_id ?? data?.output_index ?? 'unknown');
			argumentDeltasByItem[id] = (argumentDeltasByItem[id] ?? '') + (data?.delta ?? '');
		}

		if (t === 'response.function_call_arguments.done') {
			const id = String(data?.item_id ?? data?.output_index ?? 'unknown');
			argumentDoneByItem[id] = String(data?.arguments ?? '');
		}

		if (t === 'response.completed' || t === 'response.done') {
			finalResponse = data.response ?? finalResponse;
		}
	}

	const finalOutputLen = Array.isArray(finalResponse?.output)
		? finalResponse.output.length
		: -1;

	// Detailed dump of every collected item — for function_call items in
	// particular we want to see whether `arguments` is populated.
	const itemDump = doneItems.map((it: any) => {
		const base: any = { type: it?.type, id: it?.id, name: it?.name };
		if (it?.type === 'function_call') {
			base.call_id = it?.call_id;
			base.argumentsType = typeof it?.arguments;
			base.argumentsLength =
				typeof it?.arguments === 'string' ? it.arguments.length : undefined;
			base.argumentsPreview =
				typeof it?.arguments === 'string'
					? it.arguments.slice(0, 200)
					: undefined;
		}
		return base;
	});

	console.error(
		'[openai-codex-plugin][parseSseStream] event types:',
		JSON.stringify(eventTypeCounts),
		'| final.output.length:',
		finalOutputLen,
		'| done items detail:',
		JSON.stringify(itemDump),
		'| function_call_arguments.delta accumulated:',
		JSON.stringify(argumentDeltasByItem),
		'| function_call_arguments.done:',
		JSON.stringify(argumentDoneByItem),
	);

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
