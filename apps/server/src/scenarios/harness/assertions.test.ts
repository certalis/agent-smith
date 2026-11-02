import { expect, test } from "bun:test";
import { accountFailure, clientFailure, upstreamFailure } from "./assertions";
import type { RecordedUpstreamRequest } from "./fake-upstream";

function upstreamRequest(clientId: string): RecordedUpstreamRequest {
	return {
		account: "a",
		body: new TextEncoder().encode("{}"),
		headers: new Headers({ "x-ccflare-scenario-client-id": clientId }),
		method: "POST",
		path: "/v1/messages",
	};
}

test("limits upstream attempts for each concurrent scenario client", () => {
	const assertion = {
		id: "at-most-two-attempts",
		type: "upstream" as const,
		atMostPerHeader: {
			name: "x-ccflare-scenario-client-id",
			count: 2,
		},
	};

	expect(
		upstreamFailure(assertion, [
			upstreamRequest("0-0"),
			upstreamRequest("0-0"),
			upstreamRequest("0-0"),
			upstreamRequest("0-1"),
		]),
	).toContain("received 3 for 0-0");
	expect(
		upstreamFailure(assertion, [
			upstreamRequest("0-0"),
			upstreamRequest("0-0"),
			upstreamRequest("0-1"),
		]),
	).toBeUndefined();
});

test("fails an absent quota-window assertion when its account is missing", () => {
	expect(
		accountFailure(
			{
				id: "unstated-window-is-absent",
				type: "account",
				quotaWindowAbsent: { account: "codex", bucket: "unified5h" },
			},
			[],
			0,
		),
	).toBe("expected quota account codex");
});

test("response assertions select named requests and reject wrong JSON or leaked private values", () => {
	const clients = [
		{
			id: "other",
			status: 500,
			body: "not JSON",
			chunks: [],
			headers: new Headers(),
		},
		{
			id: "chosen",
			status: 410,
			body: '{"accounts":[]}',
			chunks: [],
			headers: new Headers(),
		},
		{
			id: "chosen",
			status: 200,
			body: '{"accounts":[],"private":"synthetic-secret"}',
			chunks: [],
			headers: new Headers(),
		},
	];
	const assertion = { id: "check", type: "client" as const, request: "chosen" };
	expect(
		clientFailure({ ...assertion, unorderedStatuses: [200, 410] }, clients),
	).toBeUndefined();
	expect(
		clientFailure({ ...assertion, unorderedStatuses: [200, 200] }, clients),
	).toContain("status distribution");
	expect(
		clientFailure(
			{ ...assertion, jsonPath: { path: "accounts.length", value: 0 } },
			clients,
		),
	).toBeUndefined();
	expect(
		clientFailure(
			{ ...assertion, jsonPath: { path: "accounts.length", value: 1 } },
			clients,
		),
	).toContain("received 0");
	expect(
		clientFailure(
			{ ...assertion, jsonPath: { path: "missing", value: false } },
			clients,
		),
	).toContain("received undefined");
	expect(
		clientFailure(
			{ ...assertion, bodyExcludes: ["synthetic-secret"] },
			clients,
		),
	).toContain("omit");
});
