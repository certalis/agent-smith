import type { QuotaWindow } from "@ccflare/types";
import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const fiveHours = 5 * 60 * 60 * 1_000;
const sixDays = 6 * 24 * 60 * 60 * 1_000;
const fiveHourReset = now + fiveHours;
const weeklyReset = now + sixDays;

const window = (resetAt: number, utilization: number): QuotaWindow => ({
	resetAt,
	seenAt: now,
	status: "allowed",
	utilization,
});

const seat = (name: string, fiveHour: number, weekly: number) => ({
	name,
	accountUuid: `acct-${name}`,
	quotaState: {
		windows: {
			unified5h: window(fiveHourReset, fiveHour),
			unified7d: window(weeklyReset, weekly),
		},
	},
});

const opening = (topic: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: topic }],
	});

const continuation = JSON.stringify({
	model: "claude-opus-4-5",
	messages: [
		{ role: "user", content: "map the red fox" },
		{ role: "assistant", content: "A fox is a mammal." },
		{ role: "user", content: "one more fact" },
	],
});

export default defineScenario({
	name: "a new conversation takes the lowest five-hour seat below the cap; a pinned one stays",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-busy", "acct-quiet", "acct-ahead"],
			admission_cap: 5,
			max_usage: 0.9,
		},
	},
	fleet: [
		seat("busy", 0.6, 0.05),
		seat("quiet", 0.2, 0.05),
		// Its higher weekly use stays below the hard cap, so lower 5h use wins.
		seat("ahead", 0.05, 0.5),
	],
	upstream: [
		{
			account: "ahead",
			path: "/v1/messages",
			times: 1,
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.7",
				"anthropic-ratelimit-unified-5h-reset": String(fiveHourReset / 1_000),
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.05",
				"anthropic-ratelimit-unified-7d-reset": String(weeklyReset / 1_000),
			},
			json: { ok: true },
		},
		{ account: "ahead", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "quiet", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: opening("map the red fox"), sessionId: "fox" },
		{ type: "request", body: continuation, sessionId: "fox" },
		{
			type: "request",
			body: opening("map the blue whale"),
			sessionId: "whale",
		},
	],
	assertions: [
		{
			id: "lowest-5h-wins-then-pin-holds-then-next-lowest",
			type: "upstream",
			accounts: ["ahead", "ahead", "quiet"],
		},
		{ id: "each-request-succeeds", type: "client", status: 200 },
	],
});
