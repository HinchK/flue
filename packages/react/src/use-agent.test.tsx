// @vitest-environment happy-dom

import type {
	AgentConversationObservation,
	AgentConversationObservationPhase,
	FlueClient,
} from '@flue/sdk';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFlueAgent } from './use-agent.ts';

function activeClient() {
	let phase: AgentConversationObservationPhase = 'loading';
	const listeners = new Set<() => void>();
	const observation: AgentConversationObservation = {
		getSnapshot: () => ({ conversation: undefined, offset: undefined, phase, error: undefined }),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh() {},
		close() {},
	};
	const client = {
		url: 'https://example.com/agents/assistant/demo',
		observe: () => observation,
		async send() {
			return { submissionId: 'submission-1', streamUrl: '/stream', offset: '0' };
		},
	} as unknown as FlueClient;
	return {
		client,
		publish(nextPhase: AgentConversationObservationPhase) {
			phase = nextPhase;
			for (const listener of listeners) listener();
		},
	};
}

describe('useFlueAgent callback identities', () => {
	it('keeps active callbacks stable across external store updates', () => {
		const source = activeClient();
		const { result } = renderHook(() => useFlueAgent({ client: source.client }));
		const sendMessage = result.current.sendMessage;
		const refresh = result.current.refresh;

		act(() => source.publish('live'));

		expect(result.current.sendMessage).toBe(sendMessage);
		expect(result.current.refresh).toBe(refresh);
	});

	it('keeps dormant callbacks stable across renders', async () => {
		const { result, rerender } = renderHook(() => useFlueAgent());
		const sendMessage = result.current.sendMessage;
		const refresh = result.current.refresh;

		rerender();

		expect(result.current.sendMessage).toBe(sendMessage);
		expect(result.current.refresh).toBe(refresh);
		await expect(result.current.sendMessage('hello')).rejects.toThrow(
			'cannot send without a conversation url',
		);
	});
});
