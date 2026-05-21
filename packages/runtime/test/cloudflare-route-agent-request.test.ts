import { describe, expect, it } from 'vitest';
import { createCloudflareAgentRequestRouter } from '../src/cloudflare/route-agent-request.ts';
import { InMemoryRegistrationStore, InMemorySessionStore } from '../src/internal.ts';
import type { Agent, AgentModule } from '../src/types.ts';

function createModule(result: unknown = { ok: true }): AgentModule {
	return {
		async init() {
			return {
				name: 'hello',
				id: 'inst-1',
				send() {},
				harness() {
					throw new Error('not needed');
				},
			} satisfies Agent;
		},
		onMessage() {
			return result;
		},
	};
}

function createRouter(module: AgentModule) {
	let keepAliveCalls = 0;
	let contextCalls = 0;
	const route = createCloudflareAgentRequestRouter({
		agentName: 'hello',
		instanceId: 'inst-1',
		module,
		createContext({ runId, payload, request }) {
			return {
				agentName: 'hello',
				id: 'inst-1',
				runId,
				payload,
				env: {},
				req: request,
				agentConfig: {
					systemPrompt: '',
					skills: {},
					model: undefined,
					resolveModel: () => undefined,
				},
				createDefaultEnv: async () => ({}) as never,
				defaultStore: new InMemorySessionStore(),
				registrationStore: new InMemoryRegistrationStore(),
			};
		},
		runInCloudflareContext(fn) {
			contextCalls++;
			return fn();
		},
		async keepAliveWhile(fn) {
			keepAliveCalls++;
			return fn();
		},
	});
	return { route, counts: () => ({ keepAliveCalls, contextCalls }) };
}

describe('createCloudflareAgentRequestRouter', () => {
	it('returns JSON results and runs work through Cloudflare wrappers', async () => {
		const { route, counts } = createRouter(createModule({ ok: true }));
		const response = await route(
			new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hi' }),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(counts().keepAliveCalls).toBeGreaterThanOrEqual(3);
		expect(counts().contextCalls).toBeGreaterThanOrEqual(3);
	});

	it('streams message lifecycle events over SSE', async () => {
		const { route } = createRouter(createModule({ ok: true }));
		const response = await route(
			new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hi' }),
			}),
		);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('event: message_start');
		expect(body).toContain('event: message_end');
	});
});
