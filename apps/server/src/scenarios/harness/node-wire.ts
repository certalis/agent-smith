import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientResult } from "./assertions";
import type { RecordedUpstreamRequest } from "./fake-upstream";
import type {
	WireClientResult,
	WireCommand,
	WireEvent,
	WireRequest,
} from "./node-wire-protocol";
import { durationMs, type Scenario, type UpstreamRule } from "./scenario";

const DEADLINE_MS = 5_000;

/** Wire I/O only. Scenario scheduling and assertions stay in runScenario. */
export class NodeWire {
	readonly requests: RecordedUpstreamRequest[] = [];
	connections = 0;
	url = "";
	private stderr = "";
	private readonly replies = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private readonly waiters = new Set<() => void>();
	private readonly requestIds = new Map<string, string[]>();

	private constructor(
		private readonly child: ChildProcess,
		private readonly directory: string,
		private readonly requestDeadlineMs: number,
	) {
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
		child.on("message", (message: WireEvent) => this.receive(message));
		child.once("exit", () => {
			for (const reply of this.replies.values())
				reply.reject(new Error(`Node wire child exited\n${this.stderr}`));
		});
	}

	static async start(
		rules: UpstreamRule[],
		tokens: [string, string][],
	): Promise<NodeWire> {
		const gaps = rules.map((rule) =>
			(rule.sse ?? []).reduce(
				(total, chunk) =>
					total + (chunk.nativeIdleGap ? durationMs(chunk.nativeIdleGap) : 0),
				0,
			),
		);
		const nativeIdleMs = Math.max(0, ...gaps);
		if (nativeIdleMs > 15_000)
			throw new Error(
				"Native socket-idle regression gaps must total at most 15 seconds",
			);
		const directory = mkdtempSync(join(tmpdir(), "smith-scenario-wire-"));
		let child: ChildProcess | undefined;
		try {
			const build = await Bun.build({
				entrypoints: [join(import.meta.dir, "node-wire-entry.ts")],
				outdir: directory,
				naming: "wire.mjs",
				target: "node",
			});
			if (!build.success)
				throw new Error(`Node wire build failed: ${build.logs.join("\n")}`);
			child = fork(join(directory, "wire.mjs"), [], {
				execArgv: [],
				execPath: "node",
				env: { PATH: process.env.PATH },
				silent: true,
			});
			const wire = new NodeWire(child, directory, DEADLINE_MS + nativeIdleMs);
			const ready = (await wire.command({
				type: "initialize",
				rules,
				tokens,
			})) as { url: string; pid: number };
			if (ready.pid !== child.pid)
				throw new Error("Node wire child reported another process id");
			wire.url = ready.url;
			return wire;
		} catch (error) {
			child?.kill("SIGKILL");
			rmSync(directory, { recursive: true, force: true });
			throw error;
		}
	}

	async startEdge(
		socketPath: string,
		options: Scenario["edge"],
	): Promise<void> {
		await this.command({ type: "edge", socketPath, options });
	}

	async request(
		clientId: string,
		id: string | undefined,
		request: WireRequest,
	): Promise<ClientResult> {
		if (id)
			this.requestIds.set(id, [...(this.requestIds.get(id) ?? []), clientId]);
		const result = (await this.command({
			type: "request",
			clientId,
			request,
		})) as WireClientResult;
		return { ...result, id, headers: new Headers(result.headers) };
	}

	async clientAction(
		type: "client-chunk" | "cancel",
		id: string,
	): Promise<void> {
		const clients = this.requestIds.get(id);
		if (!clients) throw new Error(`No Node wire request is named ${id}`);
		await Promise.all(
			clients.map((clientId) => this.command({ type, clientId })),
		);
	}

	async waitForRequests(count: number): Promise<void> {
		await this.waitUntil(
			() => this.requests.filter(Boolean).length >= count,
			`${count} upstream requests`,
		);
	}

	async waitForClosed(count: number): Promise<void> {
		await this.waitUntil(
			() => this.requests.filter((request) => request?.closed).length >= count,
			`${count} upstream connections to close`,
		);
	}

	async waitForHolds(): Promise<void> {}
	releaseHold(_id: string): never {
		throw new Error("Node wire upstream uses explicit connection barriers");
	}
	releaseAfterClientChunk(_id: string): never {
		throw new Error("Node wire upstream uses explicit client barriers");
	}

	async stop(): Promise<void> {
		try {
			if (this.child.exitCode === null && this.child.signalCode === null)
				await this.command({ type: "stop" });
		} finally {
			if (this.child.exitCode === null && this.child.signalCode === null) {
				const exited = new Promise<void>((resolve) =>
					this.child.once("exit", () => resolve()),
				);
				this.child.kill("SIGKILL");
				await exited;
			}
			rmSync(this.directory, { recursive: true, force: true });
		}
	}

	private receive(event: WireEvent): void {
		if (event.type === "reply") {
			const reply = this.replies.get(event.id);
			this.replies.delete(event.id);
			if (event.error)
				reply?.reject(new Error(`${event.error}\n${this.stderr}`));
			else reply?.resolve(event.value);
		} else if (event.type === "connection") this.connections++;
		else if (event.type === "upstream-request") {
			this.requests[event.index] = {
				...event,
				account: event.account,
				body: new Uint8Array(Buffer.from(event.body, "base64")),
				headers: new Headers(event.headers),
			};
		} else {
			const request = this.requests[event.index];
			if (!request)
				throw new Error(
					`Node upstream closed unrecorded request ${event.index}`,
				);
			request.closed = true;
			request.responseEnded = event.responseEnded;
		}
		for (const notify of this.waiters) notify();
	}

	private async command(command: WireCommand): Promise<unknown> {
		const id = crypto.randomUUID();
		return await this.bounded(
			new Promise((resolve, reject) => {
				this.replies.set(id, { resolve, reject });
				this.child.send({ ...command, id }, (error) => {
					if (error) reject(error);
				});
			}),
			command.type,
			command.type === "request" ? this.requestDeadlineMs : DEADLINE_MS,
		).finally(() => this.replies.delete(id));
	}

	private async waitUntil(
		condition: () => boolean,
		description: string,
	): Promise<void> {
		if (condition()) return;
		let notify = () => {};
		await this.bounded(
			new Promise<void>((resolve) => {
				notify = () => {
					if (condition()) resolve();
				};
				this.waiters.add(notify);
			}),
			description,
		).finally(() => this.waiters.delete(notify));
	}

	private async bounded<T>(
		promise: Promise<T>,
		description: string,
		deadlineMs = DEADLINE_MS,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(`Node wire deadline: ${description}\n${this.stderr}`),
							),
						deadlineMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
}
