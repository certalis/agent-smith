import { defineScenario } from "./harness/scenario";

const knownContext = (value: string) =>
	`<environment_context>\n${value}\n</environment_context>`;

const body = (context: string, opening: string) =>
	JSON.stringify({
		model: "gpt-5.6-sol",
		input: [
			{ type: "input_text", text: context },
			{ type: "input_text", text: opening },
		],
		stream: true,
	});

const first = body(knownContext("cwd=/tmp/one"), "Explain the pool");
const sameOpening = body(knownContext("cwd=/tmp/two"), "Explain the pool");
const differentOpening = body(
	knownContext("cwd=/tmp/two"),
	"Explain a different pool",
);
const taggedOne = body(
	"<customer-note>one</customer-note>",
	"Explain the pool",
);
const taggedTwo = body(
	"<customer-note>two</customer-note>",
	"Explain the pool",
);

export default defineScenario({
	name: "Codex conversation fingerprints ignore only known injected context",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{ name: "a", provider: "codex", accountUuid: "acct-a" },
		{ name: "b", provider: "codex", accountUuid: "acct-b" },
	],
	upstream: [
		{ account: "a", path: "/responses", status: 200, json: { ok: true } },
		{ account: "b", path: "/responses", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			path: "/v1/codex/responses",
			body: first,
			headers: { "session-id": "stable" },
		},
		{
			type: "request",
			path: "/v1/codex/responses",
			body: sameOpening,
			headers: { "session-id": "stable" },
		},
		{
			type: "request",
			path: "/v1/codex/responses",
			body: differentOpening,
			headers: { "session-id": "stable" },
		},
		{
			type: "request",
			path: "/v1/codex/responses",
			body: taggedOne,
			headers: { "session-id": "tagged" },
		},
		{
			type: "request",
			path: "/v1/codex/responses",
			body: taggedTwo,
			headers: { "session-id": "tagged" },
		},
	],
	assertions: [
		{
			id: "only-known-context-stays-pinned",
			type: "upstream",
			accounts: ["a", "a", "b", "a", "b"],
			bodyIdentical: [
				first,
				sameOpening,
				differentOpening,
				taggedOne,
				taggedTwo,
			],
		},
	],
});
