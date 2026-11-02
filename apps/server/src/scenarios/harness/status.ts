import { withoutProxyEnvironment } from "./spawn-server";

type AccountStatus = {
	name: string;
	quotaWindows: Record<string, { utilization: number | null }>;
	rateLimitStatus: {
		isLimited: boolean;
		until: string | null;
	};
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
	};
};

export async function readAccountStatus(
	serverUrl: string,
): Promise<AccountStatus[]> {
	return await withoutProxyEnvironment(async () => {
		const response = await fetch(`${serverUrl}/api/status`);
		if (!response.ok) {
			throw new Error(
				`Failed to read scenario account status: ${response.status} ${await response.text()}`,
			);
		}

		const status = (await response.json()) as { accounts: AccountStatus[] };
		return status.accounts;
	});
}
