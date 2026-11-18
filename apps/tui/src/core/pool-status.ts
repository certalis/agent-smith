import { Database } from "bun:sqlite";
import type { StandaloneOptions } from "@agent-smith/config/standalone";
import type { QuotaWindow } from "@agent-smith/types";

const MODEL_WINDOWS = ["Sonnet", "Opus", "Fable"] as const;

export type PoolAccountStatus = {
	name: string;
	paused: boolean;
	blocked: boolean;
	poolAllowed: boolean;
	tokenStatus: string;
	usage: {
		fiveHour: QuotaWindow | null;
		sevenDay: QuotaWindow | null;
		weeklyByModel: Record<string, QuotaWindow>;
	};
};

export type PoolStatus = {
	routingEnabled: boolean;
	maxUsagePercent: number;
	enrollmentUrl: string;
	emails: string[];
	accounts: PoolAccountStatus[];
};

type FleetAccount = {
	id: string;
	name: string;
	paused: boolean;
	tokenStatus: string;
	blockedReason: string | null;
	quotaWindows: Record<string, QuotaWindow>;
};

type TeamRouting = {
	enabled: boolean;
	allowlistedAccountUuids: string[];
	maxUsage: number;
};

type Membership = {
	id: string;
	account_uuid: string | null;
	auth_method: string;
};

export type PoolStatusSources = {
	accounts: FleetAccount[];
	routing: TeamRouting;
	emails: string[];
	memberships: Membership[];
	origin: string;
};

export function summarizePool({
	accounts,
	routing,
	emails,
	memberships,
	origin,
}: PoolStatusSources): PoolStatus {
	const byId = new Map(memberships.map((row) => [row.id, row]));
	const allowed = new Set(routing.allowlistedAccountUuids);
	return {
		routingEnabled: routing.enabled,
		maxUsagePercent: routing.maxUsage * 100,
		enrollmentUrl: `${origin}/pool-enroll`,
		emails,
		accounts: accounts.map((account) => {
			const identity = byId.get(account.id);
			const windows = account.quotaWindows ?? {};
			return {
				name: account.name,
				paused: account.paused,
				blocked: Boolean(account.blockedReason),
				poolAllowed:
					routing.enabled &&
					identity?.auth_method === "oauth" &&
					allowed.has(identity.account_uuid ?? ""),
				tokenStatus: account.tokenStatus,
				usage: {
					fiveHour: windows.unified5h ?? null,
					sevenDay: windows.unified7d ?? null,
					weeklyByModel: Object.fromEntries(
						MODEL_WINDOWS.flatMap((model) => {
							const window = windows[`unified7d${model}`];
							return window ? [[model, window]] : [];
						}),
					),
				},
			};
		}),
	};
}

function readMemberships(dbPath: string): Membership[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return database
			.query<Membership, []>(
				"SELECT id, account_uuid, auth_method FROM accounts",
			)
			.all();
	} finally {
		database.close();
	}
}

export async function readPoolStatus(
	options: Pick<
		StandaloneOptions,
		"origin" | "socketPath" | "dbPath" | "adminKey"
	>,
): Promise<PoolStatus> {
	const admin = async <T>(path: string, body?: object): Promise<T> => {
		const response = await fetch(`http://127.0.0.1/api/${path}`, {
			unix: options.socketPath,
			method: body ? "POST" : "GET",
			headers: {
				"x-api-key": options.adminKey,
				"content-type": "application/json",
			},
			...(body && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(10_000),
			redirect: "error",
		});
		if (!response.ok) throw new Error(`Pool refused /api/${path}`);
		return (await response.json()) as T;
	};
	const [{ accounts }, routing, { emails }] = await Promise.all([
		admin<{ accounts: FleetAccount[] }>("status"),
		admin<TeamRouting>("config/team-routing"),
		admin<{ emails: string[] }>("enrollment-emails", {}),
	]);
	if (
		!Array.isArray(accounts) ||
		typeof routing.enabled !== "boolean" ||
		!Array.isArray(routing.allowlistedAccountUuids) ||
		!Number.isFinite(routing.maxUsage) ||
		!Array.isArray(emails) ||
		!emails.every((email) => typeof email === "string")
	)
		throw new Error("Pool returned an unexpected status");
	return summarizePool({
		accounts,
		routing,
		emails,
		memberships: readMemberships(options.dbPath),
		origin: options.origin,
	});
}
