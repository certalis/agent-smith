import { durationMs, type RelativeTime, type UpstreamRule } from "./scenario";

export type RecordedUpstreamRequest = {
	account: string | undefined;
	body: Uint8Array;
	headers: Headers;
	manualHoldsActive?: string[];
	method: string;
	path: string;
};

type FakeUpstreamOptions = {
	rules: UpstreamRule[];
	tokenToAccount: ReadonlyMap<string, string>;
	now?: () => number;
};

const STOP_TIMEOUT_MS = 500;

type HoldState = {
	completed: Promise<void>;
	error: Error | undefined;
	expected: NonNullable<UpstreamRule["hold"]>;
	received: number;
	released: boolean;
	reject: (error: Error) => void;
	resolve: () => void;
	rule: UpstreamRule;
	timer: ReturnType<typeof setTimeout> | undefined;
	waiting: Array<{
		clientId: string | undefined;
		resolve: (response: Response) => void;
	}>;
};

function isRelativeTime(value: string | RelativeTime): value is RelativeTime {
	return typeof value !== "string";
}

function responseHeaders(
	headers: UpstreamRule["headers"],
	now: () => number,
): Headers {
	const result = new Headers();

	for (const [name, value] of Object.entries(headers ?? {})) {
		result.set(
			name,
			isRelativeTime(value)
				? String(Math.floor((now() + value.offsetMs) / 1_000))
				: value,
		);
	}

	return result;
}

function sseStream(
	chunks: NonNullable<UpstreamRule["sse"]>,
	waitForClientChunk: () => Promise<void>,
): ReadableStream {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			for (const chunk of chunks) {
				if (chunk.afterClientChunk) {
					await waitForClientChunk();
				}

				controller.enqueue(encoder.encode(chunk.body));
			}

			controller.close();
		},
	});
}

function createResponse(
	rule: UpstreamRule,
	now: () => number,
	waitForClientChunk: () => Promise<void>,
): Response {
	const headers = responseHeaders(rule.headers, now);

	if (rule.sse) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "text/event-stream");
		}
		return new Response(sseStream(rule.sse, waitForClientChunk), {
			status: rule.status,
			headers,
		});
	}

	if (rule.json !== undefined) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		return new Response(JSON.stringify(rule.json), {
			status: rule.status,
			headers,
		});
	}

	return new Response(null, { status: rule.status, headers });
}

function accountFromRequest(
	request: Request,
	tokenToAccount: ReadonlyMap<string, string>,
): string | undefined {
	const authorization = request.headers.get("authorization");
	const token = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: (request.headers.get("x-api-key") ?? undefined);

	return token ? tokenToAccount.get(token) : undefined;
}

export class FakeUpstream {
	readonly requests: RecordedUpstreamRequest[] = [];
	readonly url: string;

	private readonly holds = new Map<UpstreamRule, HoldState>();
	private readonly ruleUses = new Map<UpstreamRule, number>();
	private readonly server: ReturnType<typeof Bun.serve>;
	private readonly pendingClientChunkReleases = new Map<string, number>();
	private readonly clientChunkWaiters = new Map<string, Array<() => void>>();
	private readonly requestWaiters: Array<{
		count: number;
		resolve: () => void;
	}> = [];

	constructor(private readonly options: FakeUpstreamOptions) {
		for (const rule of options.rules) {
			if (rule.hold) {
				this.holds.set(rule, this.createHold(rule));
			}
		}

		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => this.handle(request),
		});
		this.url = `http://127.0.0.1:${this.server.port}`;
	}

	async waitForHolds(): Promise<void> {
		await Promise.all([...this.holds.values()].map((hold) => hold.completed));
	}

	async waitForRequests(count: number): Promise<void> {
		if (this.requests.length >= count) return;
		await new Promise<void>((resolve) => {
			this.requestWaiters.push({ count, resolve });
		});
	}

	releaseHold(id: string): void {
		const hold = [...this.holds.values()].find(
			(candidate) => candidate.rule.id === id,
		);
		if (!hold) {
			throw new Error(`No fake upstream hold is named ${id}`);
		}
		if (hold.expected.release !== "manual") {
			throw new Error(`Fake upstream hold ${id} is not manually released`);
		}
		if (hold.released) return;
		if (hold.received < hold.expected.received) {
			throw this.holdError(hold);
		}
		this.completeHold(hold);
	}

	recordTransportFailure(request: RecordedUpstreamRequest): void {
		this.requests.push(request);
	}

	releaseAfterClientChunk(clientId: string): void {
		const waiting = this.clientChunkWaiters.get(clientId);
		const release = waiting?.shift();
		if (release) {
			release();
		} else {
			this.pendingClientChunkReleases.set(
				clientId,
				(this.pendingClientChunkReleases.get(clientId) ?? 0) + 1,
			);
		}
	}

	async stop(): Promise<void> {
		for (const hold of this.holds.values()) {
			if (hold.timer) {
				clearTimeout(hold.timer);
			}
			if (!hold.error && !hold.released) {
				const error =
					hold.received < hold.expected.received
						? this.holdError(hold)
						: new Error(
								`Fake upstream manual hold ${hold.rule.id ?? "without an id"} was not released`,
							);
				hold.error = error;
				hold.reject(error);
				this.releaseWaiting(
					hold,
					() => new Response(error.message, { status: 500 }),
				);
			}
		}

		this.server.unref();
		const stopped = this.server.stop(true);
		await Promise.race([stopped, Bun.sleep(STOP_TIMEOUT_MS)]);
	}

	private createHold(rule: UpstreamRule): HoldState {
		if (!rule.hold) {
			throw new Error(
				"Cannot create a scenario hold without a hold definition",
			);
		}

		let resolve: () => void = () => {};
		let reject: (error: Error) => void = () => {};
		const completed = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		completed.catch(() => undefined);

		const state: HoldState = {
			completed,
			error: undefined,
			expected: rule.hold,
			received: 0,
			released: false,
			reject,
			resolve,
			rule,
			timer: undefined,
			waiting: [],
		};

		return state;
	}

	private startHoldTimer(state: HoldState): void {
		if (state.expected.release === "manual") return;
		const within = durationMs(state.expected.within ?? "5s");
		state.timer = setTimeout(() => {
			if (state.received >= state.expected.received || state.error) {
				return;
			}

			const error = this.holdError(state);
			state.error = error;
			state.reject(error);
			this.releaseWaiting(
				state,
				() => new Response(error.message, { status: 500 }),
			);
		}, within);
	}

	private holdError(hold: HoldState): Error {
		return new Error(
			`Fake upstream hold for ${hold.rule.path ?? "any path"}: expected ${hold.expected.received} requests, received ${hold.received}`,
		);
	}

	private releaseWaiting(
		hold: HoldState,
		response: (clientId: string | undefined) => Response,
	): void {
		for (const waiting of hold.waiting.splice(0)) {
			waiting.resolve(response(waiting.clientId));
		}
	}

	private completeHold(hold: HoldState): void {
		if (hold.released) return;
		hold.released = true;
		if (hold.timer) clearTimeout(hold.timer);
		hold.resolve();
		this.releaseWaiting(hold, (clientId) => this.response(hold.rule, clientId));
	}

	private notifyRequestWaiters(): void {
		for (let index = this.requestWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.requestWaiters[index];
			if (this.requests.length >= waiter.count) {
				this.requestWaiters.splice(index, 1);
				waiter.resolve();
			}
		}
	}

	private async waitForClientChunk(
		clientId: string | undefined,
	): Promise<void> {
		if (!clientId) {
			throw new Error("SSE chunk barrier requires a scenario client id");
		}

		const pending = this.pendingClientChunkReleases.get(clientId) ?? 0;
		if (pending > 0) {
			this.pendingClientChunkReleases.set(clientId, pending - 1);
			return;
		}

		await new Promise<void>((resolve) => {
			const waiting = this.clientChunkWaiters.get(clientId) ?? [];
			waiting.push(resolve);
			this.clientChunkWaiters.set(clientId, waiting);
		});
	}

	private response(rule: UpstreamRule, clientId: string | undefined): Response {
		return createResponse(rule, this.options.now ?? Date.now, () =>
			this.waitForClientChunk(clientId),
		);
	}

	private matchingRule(
		account: string | undefined,
		path: string,
	): UpstreamRule | undefined {
		return this.options.rules.find((rule) => {
			const uses = this.ruleUses.get(rule) ?? 0;
			return (
				(rule.account === undefined || rule.account === account) &&
				(rule.path === undefined || rule.path === path) &&
				uses < (rule.times ?? Number.POSITIVE_INFINITY)
			);
		});
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const clientId =
			request.headers.get("x-ccflare-scenario-client-id") ?? undefined;
		const account = accountFromRequest(request, this.options.tokenToAccount);
		const rule = this.matchingRule(account, url.pathname);
		if (rule) {
			this.ruleUses.set(rule, (this.ruleUses.get(rule) ?? 0) + 1);
		}
		this.requests.push({
			account,
			body: new Uint8Array(await request.arrayBuffer()),
			headers: new Headers(request.headers),
			manualHoldsActive: [...this.holds.values()]
				.filter(
					(hold) =>
						hold.expected.release === "manual" &&
						!hold.released &&
						hold.received > 0 &&
						hold.rule.id !== undefined &&
						hold.rule !== rule,
				)
				.map((hold) => hold.rule.id as string),
			method: request.method,
			path: url.pathname,
		});
		this.notifyRequestWaiters();

		if (!rule) {
			return new Response(
				`No fake upstream rule matched ${request.method} ${url.pathname} for ${account ?? "an unknown account"}`,
				{ status: 404 },
			);
		}

		const hold = this.holds.get(rule);
		if (!hold || hold.received >= hold.expected.received) {
			return this.response(rule, clientId);
		}
		if (hold.error) {
			return new Response(hold.error.message, { status: 500 });
		}

		hold.received += 1;
		if (!hold.timer) {
			this.startHoldTimer(hold);
		}
		return await new Promise<Response>((resolve) => {
			if (hold.released) {
				resolve(this.response(rule, clientId));
				return;
			}
			hold.waiting.push({ clientId, resolve });
			if (
				hold.received === hold.expected.received &&
				hold.expected.release !== "manual"
			) {
				this.completeHold(hold);
			}
		});
	}
}

export function startFakeUpstream(options: FakeUpstreamOptions): FakeUpstream {
	return new FakeUpstream(options);
}
