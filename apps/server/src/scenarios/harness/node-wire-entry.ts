import { once } from "node:events";
import {
	type ClientRequest,
	createServer,
	type IncomingMessage,
	request,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { createProxyEdgeHandler } from "@agent-smith/runtime-server/edge";
import type {
	WireClientResult,
	WireCommand,
	WireEvent,
	WireRequest,
} from "./node-wire-protocol";
import type { UpstreamRule } from "./scenario";

const servers: Server[] = [];
const clients = new Map<string, Client>();
let rules: UpstreamRule[] = [];
let tokens = new Map<string, string>();
const uses = new Map<UpstreamRule, number>();
let requests = 0;
let edgePort: number | undefined;

function send(event: WireEvent): void {
	process.send?.(event);
}

function headersOf(
	headers: IncomingMessage["headers"],
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).flatMap(([name, value]) =>
			typeof value === "string" ? [[name, value]] : [],
		),
	);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
	const token =
		req.headers.authorization?.replace(/^Bearer /, "") ??
		req.headers["x-api-key"];
	const account = typeof token === "string" ? tokens.get(token) : undefined;
	const rule = rules.find(
		(candidate) =>
			(!candidate.account || candidate.account === account) &&
			(!candidate.path || candidate.path === req.url) &&
			(uses.get(candidate) ?? 0) <
				(candidate.times ?? Number.POSITIVE_INFINITY),
	);
	if (rule) uses.set(rule, (uses.get(rule) ?? 0) + 1);
	const index = requests++;
	const chunks: Buffer[] = [];
	let recorded = false;
	const record = () => {
		if (recorded) return;
		recorded = true;
		send({
			type: "upstream-request",
			index,
			account,
			body: Buffer.concat(chunks).toString("base64"),
			headers: headersOf(req.headers),
			method: req.method ?? "POST",
			path: req.url ?? "/",
		});
	};
	res.once("close", () => {
		record();
		send({ type: "upstream-closed", index, responseEnded: res.writableEnded });
	});
	const respond = () => {
		record();
		if (rule?.keepOpen === "before-headers") return;
		const headers = Object.fromEntries(
			Object.entries(rule?.headers ?? {}).map(([name, value]) => {
				if (typeof value !== "string")
					throw new Error("Node wire rules require literal response headers");
				return [name, value];
			}),
		);
		if (rule?.sse) headers["content-type"] ??= "text/event-stream";
		res.writeHead(rule?.status ?? 500, headers);
		for (const chunk of rule?.sse ?? []) res.write(chunk.body);
		if (rule?.keepOpen === "after-chunks") return;
		res.end(rule?.json === undefined ? undefined : JSON.stringify(rule.json));
	};
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	if (rule?.respondAtHeaders) respond();
	else req.once("end", respond);
}

async function listen(
	server: Server,
	address: string | number,
): Promise<number | undefined> {
	servers.push(server);
	server.on("connection", () => send({ type: "connection" }));
	if (typeof address === "string") server.listen(address);
	else server.listen(address, "127.0.0.1");
	await once(server, "listening");
	const bound = server.address();
	if (!bound) throw new Error("Node wire listener did not bind");
	return typeof bound === "string" ? undefined : bound.port;
}

class Client {
	readonly done: Promise<WireClientResult>;
	readonly firstChunk: Promise<void>;
	private readonly request: ClientRequest;
	private response?: IncomingMessage;
	private finish: () => void = () => {};
	private cancelled = false;
	private readonly result: WireClientResult = {
		body: "",
		chunks: [],
		headers: {},
		status: 0,
		uploadCompleted: false,
		uploadedBytes: 0,
		uploadBufferedBytes: 0,
		cancelled: false,
	};

	constructor(input: WireRequest) {
		if (!edgePort)
			throw new Error("Start the scenario edge before its clients");
		let chunkReceived = () => {};
		this.firstChunk = new Promise<void>((resolve) => {
			chunkReceived = resolve;
		});
		let complete: (result: WireClientResult) => void = () => {};
		let fail: (error: Error) => void = () => {};
		this.done = new Promise((resolve, reject) => {
			complete = resolve;
			fail = reject;
		});
		this.request = request(
			{
				hostname: "127.0.0.1",
				port: edgePort,
				method: input.method,
				path: input.path,
				agent: false,
				headers: {
					...input.headers,
					host: "pool.example",
					...(input.upload === "headers-only"
						? { "content-length": String(Buffer.byteLength(input.body)) }
						: {}),
				},
			},
			(response) => {
				this.response = response;
				this.result.status = response.statusCode ?? 0;
				this.result.headers = headersOf(response.headers);
				response.on("data", (chunk: Buffer) => {
					const text = chunk.toString();
					this.result.chunks.push(text);
					this.result.body += text;
					chunkReceived();
				});
				response.once("end", this.finish);
				response.once("error", (error) => {
					if (!this.cancelled) fail(error);
				});
			},
		);
		this.finish = () => {
			this.result.uploadCompleted = this.request.writableEnded;
			this.result.uploadBufferedBytes = this.request.writableLength;
			this.result.cancelled = this.cancelled;
			complete(this.result);
			if (input.upload === "headers-only") this.request.destroy();
		};
		this.request.once("error", (error) => {
			if (!this.cancelled) fail(error);
		});
		if (input.upload === "headers-only") this.request.flushHeaders();
		else {
			this.result.uploadedBytes = Buffer.byteLength(input.body);
			this.request.end(input.body);
		}
		this.done.catch(() => undefined);
	}

	async cancel(): Promise<void> {
		this.cancelled = true;
		const closed = this.request.closed
			? Promise.resolve()
			: new Promise<void>((resolve) => this.request.once("close", resolve));
		this.response?.destroy();
		this.request.destroy();
		await closed;
		this.finish();
	}
}

async function execute(command: WireCommand): Promise<unknown> {
	if (command.type === "initialize") {
		rules = command.rules;
		tokens = new Map(command.tokens);
		for (const rule of rules) {
			if (rule.hold || rule.sse?.some((chunk) => chunk.afterClientChunk))
				throw new Error(
					"Node wire rules use explicit client and connection barriers",
				);
		}
		const port = await listen(createServer(serve), 0);
		return { url: `http://127.0.0.1:${port}`, pid: process.pid };
	}
	if (command.type === "edge") {
		let socketPath = command.socketPath;
		if (command.options?.privateTarget === "upstream") {
			// macOS limits Unix socket paths even under its long default temp root.
			socketPath = join(dirname(socketPath), "u.sock");
			await listen(createServer(serve), socketPath);
		} else if (command.options?.privateTarget === "missing")
			socketPath += ".missing";
		const edge = createServer(
			createProxyEdgeHandler({
				origin: "https://pool.example",
				socketPath,
				maxConcurrentRequests: command.options?.maxConcurrentRequests,
			}),
		);
		// Only private/provider connections count toward upstream assertions.
		servers.push(edge);
		edge.listen(0, "127.0.0.1");
		await once(edge, "listening");
		const bound = edge.address();
		if (!bound || typeof bound === "string")
			throw new Error("Node edge did not bind");
		edgePort = bound.port;
		return;
	}
	if (command.type === "request") {
		if (clients.has(command.clientId))
			throw new Error(`Duplicate wire client ${command.clientId}`);
		const client = new Client(command.request);
		clients.set(command.clientId, client);
		return await client.done;
	}
	if (command.type === "stop") {
		await Promise.all([...clients.values()].map((client) => client.cancel()));
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections();
						server.close(() => resolve());
					}),
			),
		);
		return;
	}
	const client = clients.get(command.clientId);
	if (!client) throw new Error(`No wire client ${command.clientId}`);
	if (command.type === "cancel") await client.cancel();
	else await client.firstChunk;
}

process.on("message", (command: WireCommand & { id: string }) => {
	void execute(command).then(
		(value) => {
			send({ type: "reply", id: command.id, value });
			if (command.type === "stop") process.disconnect?.();
		},
		(error: unknown) =>
			send({
				type: "reply",
				id: command.id,
				error:
					error instanceof Error
						? (error.stack ?? error.message)
						: String(error),
			}),
	);
});

process.on("disconnect", () => {
	for (const server of servers) server.closeAllConnections();
	process.exit(0);
});
