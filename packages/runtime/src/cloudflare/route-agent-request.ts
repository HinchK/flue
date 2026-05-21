import {
	InvalidRequestError,
	MessageQueueFullHttpError,
	parseJsonBody,
	toHttpResponse,
} from '../errors.ts';
import { createAgentContext, createFlueContext, type FlueContextConfig } from '../client.ts';
import { generateRunId } from '../runtime/ids.ts';
import { MessageDispatcher, MessageQueueFullError } from '../runtime/message-dispatcher.ts';
import type { AgentModule, DeliveryInput, FlueEvent } from '../types.ts';

export interface CloudflareAgentRequestRouterOptions {
	agentName: string;
	instanceId: string;
	module: AgentModule;
	createContext(config: {
		runId: string;
		payload: unknown;
		request: Request;
	}): FlueContextConfig;
	runInCloudflareContext<T>(fn: () => T | Promise<T>): T | Promise<T>;
	keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
	maxPendingMessages?: number;
}

export function createCloudflareAgentRequestRouter(options: CloudflareAgentRequestRouterOptions) {
	let ctx = undefined as ReturnType<typeof createFlueContext> | undefined;
	let wakeRequest: Request | undefined;
	let wakePayload: unknown;
	const dispatcher = new MessageDispatcher({
		agentName: options.agentName,
		instanceId: options.instanceId,
		maxPendingMessages: options.maxPendingMessages,
		async init(message) {
			return options.keepAliveWhile(async () => {
				ctx = createFlueContext(
					options.createContext({
						runId: generateRunId(),
						payload: wakePayload,
						request: wakeRequest ?? new Request('http://flue.invalid/'),
					}),
				);
				return Promise.resolve(
					options.runInCloudflareContext(() => options.module.init(createAgentContext(ctx!, message.metadata))),
				);
			});
		},
		async onMessage(agent, message) {
			return options.keepAliveWhile(() =>
				Promise.resolve(
					options.runInCloudflareContext(() =>
						options.module.onMessage ? options.module.onMessage(agent, message) : agent.send(message.content),
					),
				),
			);
		},
		async waitForIdle() {
			await options.keepAliveWhile(() => Promise.resolve(options.runInCloudflareContext(() => ctx?.waitForIdle())));
		},
	});

	return async (request: Request): Promise<Response> => {
		try {
			if (!options.module || typeof options.module.init !== 'function') {
				throw new Error(`[flue] Agent module "${options.agentName}" must export an init function.`);
			}
			const payload = await parseJsonBody(request);
			wakeRequest ??= request;
			wakePayload ??= payload;
			const handle = await dispatcher.deliver(normalizeHttpPayload(payload));
			if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
				return streamDelivery(handle.events());
			}
			const completion = await handle.waitForIdle();
			if (completion.error !== undefined) throw completion.error;
			if (completion.result === undefined) return new Response(null, { status: 204 });
			return new Response(JSON.stringify(completion.result), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		} catch (error) {
			if (error instanceof MessageQueueFullError) {
				return toHttpResponse(
					new MessageQueueFullHttpError({ name: options.agentName, id: options.instanceId }),
				);
			}
			return toHttpResponse(error);
		}
	};
}

function normalizeHttpPayload(payload: unknown): DeliveryInput {
	if (!isRecord(payload)) {
		throw new InvalidRequestError({ reason: 'JSON request bodies must be objects.' });
	}
	const { message, ...metadata } = payload;
	if (message !== undefined && typeof message !== 'string') {
		throw new InvalidRequestError({ reason: 'The top-level "message" field must be a string when provided.' });
	}
	return { content: message ?? '', metadata, channel: 'http' };
}

function streamDelivery(events: AsyncIterable<FlueEvent>): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	void (async () => {
		try {
			for await (const event of events) {
				const payload = [`event: ${event.type}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
				await writer.write(encoder.encode(payload));
			}
		} finally {
			try {
				await writer.close();
			} catch {
			}
		}
	})();
	return new Response(readable, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
