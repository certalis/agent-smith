import { defineScenario } from "./harness/scenario";

const body = (content: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content }],
	});

export default defineScenario({
	name: "conversation fingerprints ignore only known volatile Claude inputs",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b" },
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			sessionId: "stable",
			body: body(
				"Claude Code billing header: cycle-one\n<system-reminder>injected</system-reminder>\nExplain routing",
			),
		},
		{
			type: "request",
			sessionId: "stable",
			body: body(
				"Claude Code billing header: cycle-two\n<system-reminder>rotated</system-reminder>\nExplain routing",
			),
		},
		{
			type: "request",
			sessionId: "stable",
			body: body("Explain a different real opening"),
		},
		{
			type: "request",
			sessionId: "tagged",
			body: body("<customer-note>one</customer-note>\nExplain routing"),
		},
		{
			type: "request",
			sessionId: "tagged",
			body: body("<customer-note>two</customer-note>\nExplain routing"),
		},
	],
	assertions: [
		{
			id: "only-known-inputs-stay-pinned",
			type: "upstream",
			accounts: ["a", "a", "b", "a", "b"],
		},
	],
});
