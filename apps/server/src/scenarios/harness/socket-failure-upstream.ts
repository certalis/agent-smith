import { createServer, type Server, type Socket } from "node:net";
import type { FakeUpstream, RecordedUpstreamRequest } from "./fake-upstream";

type SocketFailureUpstream = {
	stop: () => Promise<void>;
	url: string;
};

function headersFrom(rawHeaders: string): Headers {
	const headers = new Headers();
	for (const line of rawHeaders.split("\r\n").slice(1)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		headers.append(
			line.slice(0, separator).trim(),
			line.slice(separator + 1).trim(),
		);
	}
	return headers;
}

function accountFrom(headers: Headers, tokens: ReadonlyMap<string, string>) {
	const authorization = headers.get("authorization");
	const token = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: (headers.get("x-api-key") ?? undefined);
	return token ? tokens.get(token) : undefined;
}

function recordRequest(
	raw: Buffer,
	tokenToAccount: ReadonlyMap<string, string>,
	upstream: FakeUpstream,
): void {
	const boundary = raw.indexOf("\r\n\r\n");
	if (boundary < 0) return;
	const head = raw.subarray(0, boundary).toString("utf8");
	const [method = "POST", path = "/"] = head.split("\r\n")[0].split(" ");
	const headers = headersFrom(head);
	const request: RecordedUpstreamRequest = {
		account: accountFrom(headers, tokenToAccount),
		body: new Uint8Array(raw.subarray(boundary + 4)),
		headers,
		method,
		path,
	};
	upstream.recordTransportFailure(request);
}

/**
 * An ephemeral local listener that reads the full request then resets the TCP
 * connection. It gives transport-failure scenarios an observable upstream
 * attempt without relying on fixed ports or a machine's ambient services.
 */
export async function startSocketFailureUpstream(
	tokenToAccount: ReadonlyMap<string, string>,
	upstream: FakeUpstream,
): Promise<SocketFailureUpstream> {
	const server: Server = createServer((socket: Socket) => {
		const chunks: Buffer[] = [];
		let expectedBytes: number | undefined;
		let recorded = false;

		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			const raw = Buffer.concat(chunks);
			const boundary = raw.indexOf("\r\n\r\n");
			if (boundary < 0) return;
			if (expectedBytes === undefined) {
				const headers = headersFrom(raw.subarray(0, boundary).toString("utf8"));
				expectedBytes =
					boundary + 4 + Number(headers.get("content-length") ?? 0);
			}
			if (!recorded && raw.byteLength >= expectedBytes) {
				recorded = true;
				recordRequest(raw, tokenToAccount, upstream);
				socket.destroy();
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Socket failure upstream did not receive a TCP port");
	}

	return {
		url: `http://127.0.0.1:${address.port}`,
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
