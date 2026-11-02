import { defineScenario } from "./harness/scenario";

const clientUuid = "11111111-2222-3333-4444-555555555555";
const accountUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const body = `{"model":"claude-retired","metadata":{"user_id":"{\\"account_uuid\\":\\"${clientUuid}\\",\\"device_id\\":\\"device\\"}"},"messages":[{"role":"user","content":"leave ${clientUuid} in my text"}]}`;
const rewritten = `{"model":"claude-retired","metadata":{"user_id":"{\\"account_uuid\\":\\"${accountUuid}\\",\\"device_id\\":\\"device\\"}"},"messages":[{"role":"user","content":"leave ${clientUuid} in my text"}]}`;

export default defineScenario({
	name: "an account UUID is patched only inside metadata.user_id",
	fleet: [{ name: "a", accountUuid }],
	upstream: [{ account: "a", path: "/v1/messages", status: 200, json: {} }],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "only-metadata-account-uuid-is-patched",
			type: "upstream",
			count: 1,
			bodyIdentical: rewritten,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/account-uuid-rewrite.test.js",
});
