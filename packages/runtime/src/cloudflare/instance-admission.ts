import type {
	AcquireInstanceRunInput,
	InstanceRunAdmission,
	InstanceRunLease,
} from '../runtime/instance-admission.ts';

export interface CloudflareInstanceRunState {
	activeRunId?: string;
}

export function createCloudflareInstanceRunAdmission(
	state: CloudflareInstanceRunState,
): InstanceRunAdmission {
	return new CloudflareInstanceRunAdmission(state);
}

class CloudflareInstanceRunAdmission implements InstanceRunAdmission {
	constructor(private state: CloudflareInstanceRunState) {}

	async acquire(input: AcquireInstanceRunInput): Promise<InstanceRunLease | null> {
		if (this.state.activeRunId) return null;
		this.state.activeRunId = input.runId;
		return {
			release: async () => {
				if (this.state.activeRunId === input.runId) {
					this.state.activeRunId = undefined;
				}
			},
		};
	}
}
