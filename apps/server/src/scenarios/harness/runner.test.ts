import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runScenario } from "./runner";
import { defineScenario } from "./scenario";

function scenarioWorkspaces(): string[] {
	return readdirSync(tmpdir())
		.filter((entry) => entry.startsWith("agent-smith-scenario-server-"))
		.sort();
}

test("fails an expected-red scenario once its named assertions are green", async () => {
	const scenario = defineScenario({
		name: "expected red that is now green",
		fleet: [{ name: "a" }],
		upstream: [
			{
				account: "a",
				path: "/v1/messages",
				status: 200,
				json: { ok: true },
			},
		],
		steps: [{ type: "request", body: "{}" }],
		assertions: [{ id: "client-succeeds", type: "client", status: 200 }],
		expectedRed: {
			reason: "the behavior should still be missing",
			assertions: ["client-succeeds"],
		},
	});

	await expect(runScenario(scenario)).rejects.toThrow("now green");
}, 30_000);

test("fails an unfilled upstream hold with its expected request count", async () => {
	const scenario = defineScenario({
		name: "unfilled hold",
		fleet: [{ name: "a" }],
		upstream: [
			{
				account: "a",
				path: "/v1/messages",
				status: 200,
				json: { ok: true },
				hold: { received: 2, within: "20ms" },
			},
		],
		steps: [{ type: "request", body: "{}" }],
		assertions: [],
	});

	await expect(runScenario(scenario)).rejects.toThrow(
		"expected 2 requests, received 1",
	);
}, 30_000);

test("reports a scenario account that tries to reach a provider default host", async () => {
	const before = scenarioWorkspaces();
	const scenario = defineScenario({
		name: "default provider host",
		claudeOAuth: true,
		fleet: [{ name: "a", baseUrl: "https://api.anthropic.com" }],
		upstream: [],
		steps: [{ type: "request", body: "{}" }],
		assertions: [],
	});

	const result = runScenario(scenario);
	await expect(result).rejects.toThrow("api.anthropic.com");
	await expect(result).rejects.toThrow("Server child output");
	expect(scenarioWorkspaces()).toEqual(before);
}, 30_000);

test("evaluates an account assertion that says a still-limited account is available", async () => {
	const scenario = defineScenario({
		name: "limited account is not available",
		fleet: [{ name: "a", rateLimitedFor: "6m" }],
		upstream: [],
		steps: [],
		assertions: [{ id: "a-available", type: "account", notLimited: "a" }],
		expectedRed: {
			reason: "the seeded rate limit should be visible over HTTP",
			assertions: ["a-available"],
		},
	});

	await expect(runScenario(scenario)).resolves.toBeUndefined();
}, 30_000);

test("rejects a Unix request when the scenario has no private socket", async () => {
	const scenario = defineScenario({
		name: "private transport without a private listener",
		fleet: [],
		upstream: [],
		steps: [
			{
				type: "request",
				transport: "unix",
				method: "GET",
				path: "/health",
				body: "",
			},
		],
		assertions: [],
	});

	await expect(runScenario(scenario)).rejects.toThrow(
		"Scenario Unix transport requires privateSocket: true",
	);
}, 30_000);
