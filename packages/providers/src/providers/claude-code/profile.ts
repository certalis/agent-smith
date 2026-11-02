export const CLAUDE_CODE_PROFILE_URL =
	"https://api.anthropic.com/api/oauth/profile";

export type ClaudeCodeProfile = {
	accountUuid: string;
	organizationUuid: string;
	email?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fetches the UUIDs needed to route Claude Code's account-bound metadata. */
export async function fetchClaudeCodeProfile(
	accessToken: string,
	signal?: AbortSignal,
): Promise<ClaudeCodeProfile> {
	const response = await fetch(CLAUDE_CODE_PROFILE_URL, {
		signal,
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		throw Object.assign(
			new Error(`Claude Code profile request failed: HTTP ${response.status}`),
			{ status: response.status },
		);
	}

	const payload = (await response.json()) as unknown;
	const account =
		isRecord(payload) && isRecord(payload.account)
			? payload.account
			: undefined;
	const organization =
		isRecord(payload) && isRecord(payload.organization)
			? payload.organization
			: undefined;
	if (
		typeof account?.uuid !== "string" ||
		typeof organization?.uuid !== "string"
	) {
		throw new Error("Claude Code profile response is missing account identity");
	}

	return {
		accountUuid: account.uuid,
		organizationUuid: organization.uuid,
		email: typeof account.email === "string" ? account.email : undefined,
	};
}
