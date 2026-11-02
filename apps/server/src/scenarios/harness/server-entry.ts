import { setSystemTime } from "bun:test";
import startServer, { type ServerHandle } from "../../server";

type AdvanceMessage = {
	byMs: number;
	id: string;
	type: "advance";
};

type StopMessage = {
	id: string;
	type: "stop";
};

function send(message: unknown): void {
	process.send?.(message);
}

function isLoopback(url: URL): boolean {
	return ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
}

const initialTime = Number(process.env.CCFLARE_SCENARIO_INITIAL_TIME);
let now = Number.isFinite(initialTime) ? initialTime : Date.now();
let server: ServerHandle | undefined;
const originalFetch = globalThis.fetch;
const oauthUpstream = process.env.CCFLARE_SCENARIO_CLAUDE_OAUTH_URL;
const oauthUrls = new Set([
	"https://platform.claude.com/v1/oauth/token",
	"https://api.anthropic.com/api/oauth/profile",
]);
const guardedFetch: typeof fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (oauthUpstream && oauthUrls.has(url.href)) {
			const target = new URL(url.pathname, oauthUpstream);
			if (!isLoopback(target))
				throw new Error("OAuth fixture must use a loopback upstream");
			return originalFetch(
				input instanceof Request ? new Request(target, input) : target,
				init,
			);
		}
		if (!isLoopback(url)) {
			send({ type: "fetch-guard", url: url.toString() });
			throw new Error(`Scenario child rejected non-loopback fetch: ${url}`);
		}

		return originalFetch(input, init);
	},
	{ preconnect: originalFetch.preconnect.bind(originalFetch) },
);

globalThis.fetch = guardedFetch;
setSystemTime(new Date(now));

async function stop(): Promise<void> {
	await server?.stop();
}

process.on("message", async (message: AdvanceMessage | StopMessage) => {
	try {
		if (message.type === "advance") {
			now += message.byMs;
			setSystemTime(new Date(now));
			server?.advanceRoutingClock?.();
			send({ id: message.id, now, type: "advanced" });
			return;
		}

		if (message.type === "stop") {
			await stop();
			send({ id: message.id, type: "stopped" });
			process.exit(0);
		}
	} catch (error) {
		send({
			id: message.id,
			error:
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			type: "error",
		});
	}
});

process.on("disconnect", () => {
	void stop().finally(() => process.exit(0));
});

try {
	server = startServer({
		port: 0,
		withDashboard: false,
		additionalUnixSocket: process.env.CCFLARE_SCENARIO_UNIX_SOCKET,
	});
	send({ pid: process.pid, port: server.port, type: "ready" });
} catch (error) {
	send({
		error:
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		type: "error",
	});
	process.exitCode = 1;
}
