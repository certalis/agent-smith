import { describe, expect, it } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	it("parses the explicit client-wrapper setup command", () => {
		expect(parseArgs(["install-client"])).toEqual({ installClient: true });
	});

	it("parses all supported --provider values for add-account", () => {
		for (const provider of [
			"anthropic",
			"openai",
			"claude-code",
			"codex",
		] as const) {
			expect(
				parseArgs(["--add-account", "work", "--provider", provider]),
			).toMatchObject({
				addAccount: "work",
				provider,
			});
		}
	});

	it("defers provider validation to the local configured registry", () => {
		expect(
			parseArgs(["--add-account", "work", "--provider", "acme"]),
		).toMatchObject({
			addAccount: "work",
			provider: "acme",
		});
	});

	it("rejects unsupported flags", () => {
		expect(() =>
			parseArgs([
				"--add-account",
				"work",
				"--provider",
				"anthropic",
				"--legacy-flag",
				"value",
			]),
		).toThrow();
	});

	it("rejects removed get-model flag", () => {
		expect(() => parseArgs(["--get-model"])).toThrow();
	});

	it("rejects removed set-model flag", () => {
		expect(() =>
			parseArgs(["--set-model", "claude-sonnet-4-20250514"]),
		).toThrow();
	});

	it("parses a Claude Code run helper with arguments after the separator", () => {
		expect(parseArgs(["run", "--port", "8123", "--", "-p", "hello"])).toEqual({
			port: 8123,
			run: ["-p", "hello"],
		});
	});

	it("requires a separator before Claude Code run arguments", () => {
		expect(() => parseArgs(["run", "-p", "hello"])).toThrow("requires '--'");
	});
});
