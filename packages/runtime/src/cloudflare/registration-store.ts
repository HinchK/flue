import type {
	RegistrationClaim,
	RegistrationKey,
	RegistrationStore,
} from '../runtime/registration-store.ts';

interface SqlResult {
	toArray(): SqlRow[];
}

type SqlRow = Record<string, unknown>;

export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface CloudflareRegistrationState {
	activeRegistrationKeys?: Set<string>;
}

export function createDurableRegistrationStore(
	sql: SqlStorage,
	state: CloudflareRegistrationState,
): RegistrationStore {
	ensureRegistrationTable(sql);
	return new DurableRegistrationStore(sql, state);
}

class DurableRegistrationStore implements RegistrationStore {
	private active: Set<string>;

	constructor(
		private sql: SqlStorage,
		state: CloudflareRegistrationState,
	) {
		this.active = state.activeRegistrationKeys ??= new Set<string>();
	}

	async claim(registration: RegistrationKey): Promise<RegistrationClaim | null> {
		const key = createRegistrationKey(registration);
		if (this.active.has(key) || this.isCompleted(registration)) return null;
		this.active.add(key);
		return {
			complete: async () => {
				this.sql.exec(
					`INSERT OR REPLACE INTO flue_registration_slots
					 (agent_name, instance_id, status, updated_at)
					 VALUES (?, ?, ?, ?)`,
					registration.agentName,
					registration.instanceId,
					'completed',
					Date.now(),
				);
				this.active.delete(key);
			},
			release: async () => {
				this.active.delete(key);
			},
		};
	}

	private isCompleted(registration: RegistrationKey): boolean {
		const rows = this.sql
			.exec(
				`SELECT status FROM flue_registration_slots
				 WHERE agent_name = ? AND instance_id = ?`,
				registration.agentName,
				registration.instanceId,
			)
			.toArray();
		const row = rows[0] as { status?: unknown } | undefined;
		if (row?.status === 'completed') return true;
		if (row?.status === 'active') {
			this.sql.exec(
				`DELETE FROM flue_registration_slots
				 WHERE agent_name = ? AND instance_id = ? AND status = ?`,
				registration.agentName,
				registration.instanceId,
				'active',
			);
		}
		return false;
	}
}

function createRegistrationKey(registration: RegistrationKey): string {
	return JSON.stringify([registration.agentName, registration.instanceId]);
}

function ensureRegistrationTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_registration_slots (
		 agent_name TEXT NOT NULL,
		 instance_id TEXT NOT NULL,
		 status TEXT NOT NULL,
		 updated_at INTEGER NOT NULL,
		 PRIMARY KEY (agent_name, instance_id)
		)`,
	);
}
