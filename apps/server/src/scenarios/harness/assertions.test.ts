import { expect, test } from "bun:test";
import { accountFailure, clientFailure, upstreamFailure } from "./assertions";
import type { RecordedUpstreamRequest } from "./fake-upstream";

function upstreamRequest(clientId: string): RecordedUpstreamRequest {
	return {
		account: "a",
		body: new TextEncoder().encode("{}"),
		headers: new Headers({ "x-agent-smith-scenario-client-id": clientId }),
		method: "POST",
		path: "/v1/messages",
	};
}

test("limits upstream attempts for each concurrent scenario client", () => {
	const assertion = {
		id: "at-most-two-attempts",
		type: "upstream" as const,
		atMostPerHeader: {
			name: "x-agent-smith-scenario-client-id",
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

test("grades only the requests on the named path, each body against every text", () => {
	const alert = {
		...upstreamRequest("0-0"),
		body: new TextEncoder().encode('{"text":"seat-a spent extra usage"}'),
		path: "/services/T/B/x",
	};
	const assertion = {
		id: "one-alert",
		type: "upstream" as const,
		onPath: "/services/T/B/x",
		count: 1,
		bodyIncludes: ["seat-a", "extra usage"],
	};

	expect(
		upstreamFailure(assertion, [upstreamRequest("0-0"), alert]),
	).toBeUndefined();
	expect(
		upstreamFailure({ ...assertion, bodyIncludes: ["seat-b"] }, [alert]),
	).toContain('include "seat-b"');
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

test.each([
	{ assertion: { connections: 2 }, message: "upstream connections" },
	{ assertion: { closed: 0 }, message: "closed upstream requests" },
	{ assertion: { responsesEnded: 0 }, message: "ended upstream responses" },
])("rejects mismatched Node wire counts: $message", ({
	assertion,
	message,
}) => {
	expect(
		upstreamFailure(
			{ id: "wire", type: "upstream", ...assertion },
			[{ ...upstreamRequest("0-0"), closed: true, responseEnded: true }],
			1,
		),
	).toContain(message);
});

test.each([
	{
		assertion: { uploadCompleted: false },
		observation: { uploadCompleted: true },
		field: "uploadCompleted",
	},
	{
		assertion: { uploadedBytes: 0 },
		observation: { uploadedBytes: 1 },
		field: "uploadedBytes",
	},
	{
		assertion: { cancelled: true },
		observation: { cancelled: false },
		field: "cancelled",
	},
	{
		assertion: { uploadBufferedBytes: 0 },
		observation: { uploadBufferedBytes: 1 },
		field: "uploadBufferedBytes",
	},
	{
		assertion: { connectionRefused: true },
		observation: { connectionRefused: false },
		field: "connectionRefused",
	},
])("rejects mismatched Node client observation: $field", ({
	assertion,
	observation,
	field,
}) => {
	expect(
		clientFailure({ id: "wire", type: "client", ...assertion }, [
			{
				status: 401,
				body: "",
				chunks: [],
				headers: new Headers(),
				...observation,
			},
		]),
	).toContain(field);
});
