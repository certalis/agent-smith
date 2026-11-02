import {
	type AssertionFailure,
	type ClientResult,
	evaluateAssertions,
} from "./assertions";
import { startFakeUpstream } from "./fake-upstream";
import { seedFleet } from "./fleet";
import { durationMs, type RequestStep, type Scenario } from "./scenario";
import { startSocketFailureUpstream } from "./socket-failure-upstream";
import {
	type SpawnedServer,
	spawnServer,
	withoutProxyEnvironment,
} from "./spawn-server";

const INITIAL_TIME = 1_700_000_000_000;
const SCENARIO_TIMEOUT_MS = 20_000;

function waitFor<T>(promise: Promise<T>, description: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() =>
				reject(
					new Error(
						`Scenario exceeded ${SCENARIO_TIMEOUT_MS}ms: ${description}`,
					),
				),
			SCENARIO_TIMEOUT_MS,
		);
	});

	return Promise.race([promise, deadline]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
}

async function readClientBody(
	response: Response,
	onChunk?: () => void,
): Promise<{
	body: string;
	chunks: string[];
}> {
	if (!response.body) {
		return { body: "", chunks: [] };
	}

	const chunks: string[] = [];
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let body = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		onChunk?.();

		const chunk = decoder.decode(value, { stream: true });
		if (chunk) {
			chunks.push(chunk);
			body += chunk;
		}
	}

	const remainder = decoder.decode();
	if (remainder) {
		chunks.push(remainder);
		body += remainder;
	}
	return { body, chunks };
}

async function request(
	server: SpawnedServer,
	step: RequestStep,
	stepIndex: number,
	values: ReadonlyMap<string, string>,
	onChunk?: (clientId: string) => void,
): Promise<ClientResult[]> {
	const unix = step.transport === "unix" ? server.unixSocket : undefined;
	if (step.transport === "unix" && !unix) {
		throw new Error("Scenario Unix transport requires privateSocket: true");
	}
	const baseUrl = unix ? "http://localhost" : server.url;
	const substitute = (value: string) =>
		value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
			const captured = values.get(key);
			if (captured === undefined)
				throw new Error(`No scenario response value named ${key}`);
			return captured;
		});
	const count = step.count ?? 1;
	const path = substitute(step.path ?? "/v1/claude-code/v1/messages");
	return await Promise.all(
		Array.from({ length: count }, async (_, clientIndex) => {
			const clientId = `${stepIndex}-${clientIndex}`;
			const headers = new Headers(step.headers);
			if (!headers.has("content-type")) {
				headers.set("content-type", "application/json");
			}
			if (step.sessionId) {
				headers.set("x-claude-code-session-id", step.sessionId);
			}
			headers.set("x-ccflare-scenario-client-id", clientId);

			return await withoutProxyEnvironment(async () => {
				const response = await fetch(`${baseUrl}${path}`, {
					unix,
					method: step.method ?? "POST",
					headers,
					body: step.method === "GET" ? undefined : substitute(step.body),
					signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
				});
				return {
					id: step.id,
					...(await readClientBody(response, () => onChunk?.(clientId))),
					headers: new Headers(response.headers),
					status: response.status,
				};
			});
		}),
	);
}

function expectedRedFailure(
	scenario: Scenario,
	failures: Awaited<ReturnType<typeof evaluateAssertions>>,
): Error | undefined {
	if (!scenario.expectedRed) {
		return failures.length > 0
			? new Error(
					failures
						.map((failure) => `[${failure.id}] ${failure.message}`)
						.join("\n"),
				)
			: undefined;
	}

	if (failures.length === 0) {
		return new Error(
			`Expected-red scenario '${scenario.name}' is now green: ${scenario.expectedRed.reason}`,
		);
	}

	const actual = failures.map((failure) => failure.id).sort();
	const expected = [...scenario.expectedRed.assertions].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		return new Error(
			`Expected-red scenario '${scenario.name}' failed the wrong assertions: expected ${expected.join(", ")}, received ${actual.join(", ")}`,
		);
	}

	return undefined;
}

function captureResponse(
	step: RequestStep,
	responses: ClientResult[],
	values: Map<string, string>,
): void {
	if (!step.capture) return;
	const success = responses.find(
		(response) => response.status >= 200 && response.status < 300,
	);
	if (!success)
		throw new Error(
			`Cannot capture response ${step.id ?? "without id"}: ${responses.map((response) => response.status).join(", ")}`,
		);
	const body: unknown = JSON.parse(success.body);
	for (const [name, selector] of Object.entries(step.capture)) {
		const field = selector.field
			.split(".")
			.reduce<unknown>(
				(value, key) =>
					value !== null && typeof value === "object"
						? Reflect.get(value, key)
						: undefined,
				body,
			);
		if (typeof field !== "string")
			throw new Error(`Expected response string field ${selector.field}`);
		const value = selector.fragment
			? new URL(field).hash.slice(1)
			: selector.query
				? new URL(field).searchParams.get(selector.query)
				: field;
		if (!value) throw new Error(`Empty response capture ${name}`);
		values.set(name, value);
	}
}

function childOutput(server: SpawnedServer | undefined): string {
	if (!server) return "";
	const output = [
		server.output.stdout && `stdout:\n${server.output.stdout}`,
		server.output.stderr && `stderr:\n${server.output.stderr}`,
	]
		.filter(Boolean)
		.join("\n");
	return output ? `\nServer child output:\n${output}` : "";
}

function configForScenario(scenario: Scenario): Record<string, unknown> {
	const configuredProviders =
		typeof scenario.config?.providers === "object" &&
		scenario.config.providers !== null &&
		!Array.isArray(scenario.config.providers)
			? (scenario.config.providers as Record<string, unknown>)
			: {};
	const scenarioProviders = new Set(
		scenario.fleet.map((account) => account.provider ?? "claude-code"),
	);
	const usesClaudeSignIn =
		scenario.claudeOAuth ||
		scenario.environment?.CF_ENROLLMENT_ORIGIN !== undefined;
	if (usesClaudeSignIn) scenarioProviders.add("claude-code");

	return {
		...scenario.config,
		providers: {
			...Object.fromEntries(
				[...scenarioProviders].map((provider) => [provider, { enabled: true }]),
			),
			...configuredProviders,
		},
	};
}

export async function runScenario(scenario: Scenario): Promise<void> {
	await withoutProxyEnvironment(() => runScenarioWithoutProxy(scenario));
}

async function runScenarioWithoutProxy(scenario: Scenario): Promise<void> {
	let now = INITIAL_TIME;
	const tokenToAccount = new Map<string, string>();
	const upstream = startFakeUpstream({
		rules: scenario.upstream,
		tokenToAccount,
		now: () => now,
	});
	const socketFailureUpstream = scenario.fleet.some(
		(account) => account.transportFailure,
	)
		? await startSocketFailureUpstream(tokenToAccount, upstream)
		: undefined;
	let server: SpawnedServer | undefined;

	try {
		server = await spawnServer({
			config: configForScenario(scenario),
			privateSocket: scenario.privateSocket,
			environment: {
				...scenario.environment,
				...(scenario.claudeOAuth
					? { CCFLARE_SCENARIO_CLAUDE_OAUTH_URL: upstream.url }
					: {}),
			},
			initialTime: now,
			seed: (workspace) => {
				const fleet = seedFleet({
					accounts: scenario.fleet.map((account) =>
						account.transportFailure
							? { ...account, baseUrl: socketFailureUpstream?.url }
							: account,
					),
					dbPath: workspace.dbPath,
					defaultBaseUrl: upstream.url,
					now: () => now,
				});
				for (const [token, account] of fleet.tokenToAccount) {
					tokenToAccount.set(token, account);
				}
			},
		});

		const clients: ClientResult[] = [];
		const values = new Map<string, string>();
		const pendingRequests = new Map<string, Promise<ClientResult[]>>();
		const stepFailures: AssertionFailure[] = [];
		const releaseSseChunk = scenario.upstream.some((rule) =>
			rule.sse?.some((chunk) => chunk.afterClientChunk),
		)
			? (clientId: string) => upstream.releaseAfterClientChunk(clientId)
			: undefined;
		await waitFor(
			(async () => {
				for (const [stepIndex, step] of scenario.steps.entries()) {
					if (step.type === "advance") {
						await server.advance(step.by);
						now += durationMs(step.by);
					} else if (step.type === "restart") {
						if (pendingRequests.size > 0)
							throw new Error("Cannot restart with pending requests");
						server = await server.restart(now);
					} else if (step.type === "block-config-write") {
						server.blockConfigWrite();
					} else if (step.type === "restore-config-write") {
						server.restoreConfigWrite();
					} else if (step.type === "request") {
						const responses = request(
							server,
							step,
							stepIndex,
							values,
							releaseSseChunk,
						);
						if (step.waitForUpstream !== undefined) {
							await upstream.waitForRequests(step.waitForUpstream);
						}
						if (step.waitForCompletion === false) {
							if (!step.id) {
								throw new Error("A pending request step requires an id");
							}
							if (pendingRequests.has(step.id)) {
								throw new Error(`Duplicate pending request id ${step.id}`);
							}
							pendingRequests.set(step.id, responses);
						} else {
							const completed = await responses;
							clients.push(...completed);
							captureResponse(step, completed, values);
						}
					} else if (step.type === "release") {
						upstream.releaseHold(step.id);
					} else if (step.type === "flush") {
						await new Promise<void>((resolve) => setImmediate(resolve));
					} else if (step.type === "wait-for-upstream") {
						await upstream.waitForRequests(step.count);
					} else if (step.type === "await") {
						const responses = pendingRequests.get(step.id);
						if (!responses) {
							throw new Error(`No pending request is named ${step.id}`);
						}
						clients.push(...(await responses));
						pendingRequests.delete(step.id);
					} else {
						stepFailures.push(
							...(await evaluateAssertions(step.assertions, {
								clients,
								now,
								serverUrl: server.url,
								upstream,
							})),
						);
					}
				}
				if (pendingRequests.size > 0) {
					throw new Error(
						`Scenario left pending requests: ${[...pendingRequests.keys()].join(", ")}`,
					);
				}
				await upstream.waitForHolds();
			})(),
			scenario.name,
		);

		if (server.guardedUrls.length > 0) {
			throw new Error(
				`Scenario child rejected non-loopback fetches: ${server.guardedUrls.join(", ")}`,
			);
		}

		const failures = [
			...stepFailures,
			...(await evaluateAssertions(scenario.assertions, {
				clients,
				now,
				serverUrl: server.url,
				upstream,
			})),
		];
		const error = expectedRedFailure(scenario, failures);
		if (error) throw error;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}${childOutput(server)}`,
		);
	} finally {
		await server?.stop();
		await socketFailureUpstream?.stop();
		await upstream.stop();
	}
}
