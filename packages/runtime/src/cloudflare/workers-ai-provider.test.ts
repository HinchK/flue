import { describe, expect, it } from 'vitest';
import { cloudflareBindingProvider } from './workers-ai-provider.ts';

function sseResponse(chunks: unknown[]): Response {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function providerFor(chunks: unknown[]) {
	const binding = {
		async run() {
			return sseResponse(chunks);
		},
	};
	const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
	const model = provider.getModels().find((candidate) => candidate.id.startsWith('@cf/'));
	if (!model) throw new Error('Expected a Workers AI catalog model');
	return { provider, model };
}

describe('Cloudflare Workers AI assistant content', () => {
	it.each([
		['null', { role: 'assistant', content: null }],
		['omitted', { role: 'assistant' }],
	])('treats %s content as no text and continues processing tool calls', async (_name, delta) => {
		const { provider, model } = providerFor([
			{ choices: [{ delta }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: 'call_1',
									function: { name: 'lookup', arguments: '{}' },
								},
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
		]);

		const result = await provider.streamSimple(model, { messages: [] }).result();

		expect(result.stopReason).toBe('toolUse');
		expect(result.content).toEqual([
			{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: {} },
		]);
	});

	it.each([
		['an object', { unexpected: true }],
		['an array', ['unexpected']],
	])('rejects content containing %s', async (description, content) => {
		const { provider, model } = providerFor([
			{ choices: [{ delta: { role: 'assistant', content } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
		]);

		const result = await provider.streamSimple(model, { messages: [] }).result();

		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toContain(
			`invalid choices[0].delta.content: expected a string, null, or an omitted field; received ${description}`,
		);
	});
});
