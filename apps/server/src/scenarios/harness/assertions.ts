import type { FakeUpstream, RecordedUpstreamRequest } from "./fake-upstream";
import type {
	AccountAssertion,
	ClientAssertion,
	ScenarioAssertion,
	UpstreamAssertion,
} from "./scenario";
import { readAccountStatus } from "./status";

export type ClientResult = {
	id?: string;
	body: string;
	chunks: string[];
	headers: Headers;
	status: number;
};

export type AssertionFailure = {
	id: string;
	message: string;
};

type AssertionContext = {
	clients: ClientResult[];
	now: number;
	serverUrl: string;
	upstream: FakeUpstream;
};

const ACCOUNT_ASSERTION_TIMEOUT_MS = 2_000;

export function upstreamFailure(
	assertion: UpstreamAssertion,
	requests: RecordedUpstreamRequest[],
): string | undefined {
	if (assertion.count !== undefined && requests.length !== assertion.count) {
		return `expected ${assertion.count} upstream requests, received ${requests.length}`;
	}

	if (assertion.atMostPerHeader) {
		const { count, name } = assertion.atMostPerHeader;
		const requestsByHeader = new Map<string, number>();
		for (const request of requests) {
			const value = request.headers.get(name);
			if (!value) {
				return `expected every upstream request to include ${name}`;
			}
			requestsByHeader.set(value, (requestsByHeader.get(value) ?? 0) + 1);
		}

		const excess = [...requestsByHeader.entries()].find(
			([, received]) => received > count,
		);
		if (excess) {
			return `expected at most ${count} upstream requests per ${name}, received ${excess[1]} for ${excess[0]}`;
		}
	}

	if (assertion.eachHeaderIncludesAccount) {
		const { account, count, name } = assertion.eachHeaderIncludesAccount;
		const accountsByHeader = new Map<string, Set<string | undefined>>();
		for (const request of requests) {
			const value = request.headers.get(name);
			if (!value) {
				return `expected every upstream request to include ${name}`;
			}
			const accounts = accountsByHeader.get(value) ?? new Set();
			accounts.add(request.account);
			accountsByHeader.set(value, accounts);
		}

		if (count !== undefined && accountsByHeader.size !== count) {
			return `expected ${count} distinct ${name} values, received ${accountsByHeader.size}`;
		}
		if (
			[...accountsByHeader.values()].some((accounts) => !accounts.has(account))
		) {
			return `expected every ${name} to include upstream account ${account}`;
		}
	}

	if (assertion.atLeastAccount) {
		const { count, name } = assertion.atLeastAccount;
		const received = requests.filter(
			(request) => request.account === name,
		).length;
		if (received < count) {
			return `expected at least ${count} upstream requests for account ${name}, received ${received}`;
		}
	}

	if (assertion.accounts) {
		const accounts = requests.map((request) => request.account);
		if (JSON.stringify(accounts) !== JSON.stringify(assertion.accounts)) {
			return `expected upstream accounts ${JSON.stringify(assertion.accounts)}, received ${JSON.stringify(accounts)}`;
		}
	}

	if (
		assertion.neverWhileHold &&
		requests.some((request) =>
			request.manualHoldsActive?.includes(assertion.neverWhileHold as string),
		)
	) {
		const blocked = requests
			.map((request, index) => ({ index, holds: request.manualHoldsActive }))
			.filter(({ holds }) =>
				holds?.includes(assertion.neverWhileHold as string),
			)
			.map(({ index }) => index);
		return `expected no upstream request while manual hold ${assertion.neverWhileHold} was active; requests ${blocked.join(", ")} arrived too early`;
	}

	if (
		assertion.path &&
		requests.some((request) => request.path !== assertion.path)
	) {
		return `expected every upstream request at ${assertion.path}`;
	}

	if (assertion.header) {
		const { name, value } = assertion.header;
		if (requests.some((request) => request.headers.get(name) !== value)) {
			return `expected every upstream request header ${name} to equal ${value}`;
		}
	}

	const absentHeader = assertion.headerAbsent;
	if (
		absentHeader &&
		requests.some((request) => request.headers.has(absentHeader))
	) {
		return `expected every upstream request to omit ${absentHeader}`;
	}

	if (assertion.bodyIdentical !== undefined) {
		const expected = Array.isArray(assertion.bodyIdentical)
			? assertion.bodyIdentical
			: requests.map(() => assertion.bodyIdentical);
		const actual = requests.map((request) =>
			new TextDecoder().decode(request.body),
		);
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			return `expected byte-identical upstream bodies ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
		}
	}

	return undefined;
}

export function clientFailure(
	assertion: ClientAssertion,
	clients: ClientResult[],
): string | undefined {
	const selectedClients =
		assertion.request !== undefined
			? clients.filter((client) => client.id === assertion.request)
			: assertion.index === undefined
				? clients
				: clients[assertion.index]
					? [clients[assertion.index]]
					: [];
	if (selectedClients.length === 0) {
		return "expected a client response, but no request step ran";
	}

	if (
		assertion.status !== undefined &&
		selectedClients.some((client) => client.status !== assertion.status)
	) {
		return `expected every client status to be ${assertion.status}, received ${selectedClients.map((client) => client.status).join(", ")}`;
	}
	if (
		assertion.statuses !== undefined &&
		JSON.stringify(selectedClients.map((client) => client.status)) !==
			JSON.stringify(assertion.statuses)
	) {
		return `expected client statuses ${assertion.statuses.join(", ")}, received ${clients.map((client) => client.status).join(", ")}`;
	}
	if (
		assertion.unorderedStatuses !== undefined &&
		JSON.stringify(selectedClients.map((client) => client.status).sort()) !==
			JSON.stringify([...assertion.unorderedStatuses].sort())
	) {
		return `expected client status distribution ${assertion.unorderedStatuses.join(", ")}, received ${selectedClients.map((client) => client.status).join(", ")}`;
	}

	if (
		assertion.body !== undefined &&
		selectedClients.some((client) => client.body !== assertion.body)
	) {
		return `expected every client body to equal ${JSON.stringify(assertion.body)}`;
	}
	if (
		assertion.bodyIncludes !== undefined &&
		selectedClients.some(
			(client) => !client.body.includes(assertion.bodyIncludes as string),
		)
	) {
		return `expected every client body to include ${JSON.stringify(assertion.bodyIncludes)}`;
	}

	if (
		assertion.chunks !== undefined &&
		selectedClients.some(
			(client) =>
				JSON.stringify(client.chunks) !== JSON.stringify(assertion.chunks),
		)
	) {
		return `expected every client response chunks to equal ${JSON.stringify(assertion.chunks)}`;
	}
	if (assertion.bodyExcludes) {
		for (const value of assertion.bodyExcludes)
			if (selectedClients.some((client) => client.body.includes(value)))
				return `expected every client body to omit ${JSON.stringify(value)}`;
	}
	if (assertion.jsonPath) {
		const { path, value } = assertion.jsonPath;
		for (const client of selectedClients) {
			let actual: unknown;
			try {
				actual = JSON.parse(client.body);
				for (const key of path.split("."))
					actual =
						actual != null && typeof actual === "object"
							? Reflect.get(actual, key)
							: undefined;
			} catch {
				return `expected JSON response at ${path}`;
			}
			if (JSON.stringify(actual) !== JSON.stringify(value))
				return `expected JSON ${path} to equal ${JSON.stringify(value)}, received ${JSON.stringify(actual)}`;
		}
	}

	if (assertion.header) {
		const { name, value } = assertion.header;
		if (selectedClients.some((client) => client.headers.get(name) !== value)) {
			return `expected every client header ${name} to equal ${value}`;
		}
	}

	const absentHeader = assertion.headerAbsent;
	if (
		absentHeader &&
		selectedClients.some((client) => client.headers.has(absentHeader))
	) {
		return `expected every client response to omit ${absentHeader}`;
	}

	return undefined;
}

export function accountFailure(
	assertion: AccountAssertion,
	accounts: Awaited<ReturnType<typeof readAccountStatus>>,
	now: number,
): string | undefined {
	if (assertion.current) {
		const current = accounts
			.filter((account) => account.sessionInfo.active)
			.sort(
				(left, right) =>
					Date.parse(right.sessionInfo.startedAt ?? "") -
					Date.parse(left.sessionInfo.startedAt ?? ""),
			)[0];
		if (current?.name !== assertion.current) {
			return `expected current account ${assertion.current}, received ${current?.name ?? "none"}`;
		}
	}

	if (assertion.limited) {
		const account = accounts.find(
			(candidate) => candidate.name === assertion.limited,
		);
		if (!account?.rateLimitStatus.isLimited) {
			return `expected account ${assertion.limited} to be rate limited`;
		}
	}

	if (assertion.notLimited) {
		const account = accounts.find(
			(candidate) => candidate.name === assertion.notLimited,
		);
		if (!account || account.rateLimitStatus.isLimited) {
			return `expected account ${assertion.notLimited} not to be rate limited; it is limited until ${account?.rateLimitStatus.until ?? "unknown"} at ${new Date(now).toISOString()}`;
		}
	}

	if (assertion.limitedUntil) {
		const accountName = assertion.limited;
		const account = accountName
			? accounts.find((candidate) => candidate.name === accountName)
			: accounts.find((candidate) => candidate.rateLimitStatus.isLimited);
		const expected =
			typeof assertion.limitedUntil === "string"
				? assertion.limitedUntil
				: new Date(now + assertion.limitedUntil.offsetMs).toISOString();
		if (account?.rateLimitStatus.until !== expected) {
			return `expected rate-limit reset ${expected}, received ${account?.rateLimitStatus.until ?? "none"}`;
		}
	}

	if (assertion.quotaWindow) {
		const account = accounts.find(
			(candidate) => candidate.name === assertion.quotaWindow?.account,
		);
		const window = account?.quotaWindows[assertion.quotaWindow.bucket];
		if (window?.utilization !== assertion.quotaWindow.utilization) {
			return `expected ${assertion.quotaWindow.account} quota ${assertion.quotaWindow.bucket} utilization ${assertion.quotaWindow.utilization}, received ${window?.utilization ?? "unknown"}`;
		}
	}

	if (assertion.quotaWindowAbsent) {
		const account = accounts.find(
			(candidate) => candidate.name === assertion.quotaWindowAbsent?.account,
		);
		if (!account) {
			return `expected quota account ${assertion.quotaWindowAbsent.account}`;
		}
		if (account.quotaWindows[assertion.quotaWindowAbsent.bucket]) {
			return `expected ${assertion.quotaWindowAbsent.account} quota ${assertion.quotaWindowAbsent.bucket} to be absent`;
		}
	}

	return undefined;
}

export async function evaluateAssertions(
	assertions: ScenarioAssertion[],
	context: AssertionContext,
): Promise<AssertionFailure[]> {
	const failures: AssertionFailure[] = [];
	const accountAssertions: AccountAssertion[] = [];

	for (const assertion of assertions) {
		if (assertion.type === "upstream") {
			const message = upstreamFailure(assertion, context.upstream.requests);
			if (message) failures.push({ id: assertion.id, message });
		} else if (assertion.type === "client") {
			const message = clientFailure(assertion, context.clients);
			if (message) failures.push({ id: assertion.id, message });
		} else {
			accountAssertions.push(assertion);
		}
	}

	if (accountAssertions.length === 0) {
		return failures;
	}

	const deadline = performance.now() + ACCOUNT_ASSERTION_TIMEOUT_MS;
	let accountFailures: AssertionFailure[] = [];
	do {
		const accounts = await readAccountStatus(context.serverUrl);
		accountFailures = accountAssertions.flatMap((assertion) => {
			const message = accountFailure(assertion, accounts, context.now);
			return message ? [{ id: assertion.id, message }] : [];
		});
		if (accountFailures.length === 0) {
			return failures;
		}
		await Bun.sleep(20);
	} while (performance.now() < deadline);

	return [...failures, ...accountFailures];
}
