import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture(enrollment_emails: string[]) {
	const directory = mkdtempSync(
		join(tmpdir(), "agent-smith-enrollment-rules-"),
	);
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			enrollment_emails,
			providers: {
				"claude-code": { pool: { enabled: false, max_usage: 0.8 } },
			},
		}),
	);
	return { config: new Config(path), path };
}

describe("enrollment email and exact-domain rules", () => {
	it("matches only the exact listed domain or individual email, including normalized file rules", () => {
		const { config } = fixture([" *@EXAMPLE.TEST ", " Invited@Outside.test "]);
		for (const [email, allowed] of [
			["new@example.test", true],
			[" NEW@Example.test ", true],
			["invited@outside.test", true],
			["new@sub.example.test", false],
			["new@example.test.evil", false],
			["new@notexample.test", false],
			["other@outside.test", false],
			["*@example.test", false],
			["a@@example.test", false],
		] as const)
			expect(config.isEnrollmentEmailAllowed(email)).toBe(allowed);
	});

	it("persists normalized deduplicated rules and live removal without changing pool policy", () => {
		const { config, path } = fixture([]);
		config.setEnrollmentEmails([
			" *@EXAMPLE.TEST ",
			"*@example.test",
			"invited@outside.test",
		]);
		expect(new Config(path).isEnrollmentEmailAllowed("new@example.test")).toBe(
			true,
		);
		expect(config.getEnrollmentEmails()).toEqual([
			"*@example.test",
			"invited@outside.test",
		]);
		config.setEnrollmentEmails(["invited@outside.test"]);
		expect(config.isEnrollmentEmailAllowed("new@example.test")).toBe(false);
		expect(new Config(path).getTeamRouting("claude-code")).toMatchObject({
			enabled: false,
			maxUsage: 0.8,
		});
	});

	it.each([
		"*@*.example.test",
		"*@example.test/path",
		"*@example.test:443",
		"a*@example.test",
		"*@sub..example.test",
		"*@-example.test",
		"*@example.test.",
		"*",
	])("rejects invalid rule %s without changing saved admission", (rule) => {
		const { config, path } = fixture(["owner@example.test"]);
		const saved = readFileSync(path, "utf8");
		expect(() =>
			config.setEnrollmentEmails([rule, "other@outside.test"]),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(saved);
		expect(config.getEnrollmentEmails()).toEqual(["owner@example.test"]);
	});
});
