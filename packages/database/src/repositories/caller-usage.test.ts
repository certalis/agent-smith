import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema, runMigrations } from "../migrations";
import { type RequestData, RequestRepository } from "./request.repository";

// # | Unit | Case | Population | Status
// 1 | Storage | Nullable migration, old rows and reopen | SQLite unit | RED
// 2 | Storage | Immutable start owner and completion fallback | SQLite unit | RED
// 3 | Report | Completed, pending and unreported token totals | SQLite unit | RED
// 4 | Report | Time, model and caller filters | SQLite unit | RED
describe("caller usage", () => {
	let db: Database;
	let repository: RequestRepository;
	let tempDir: string;
	let databasePath: string;
	const window = { startMs: 1_000, endMs: 2_000 };
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-smith-caller-usage-"));
		databasePath = join(tempDir, "requests.db");
		db = new Database(databasePath);
		ensureSchema(db);
		runMigrations(db);
		repository = new RequestRepository(db);
	});
	afterEach(() => {
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	function start(id: string, callerId: string | null) {
		repository.saveMeta(
			id,
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			null,
			null,
			1_500,
			callerId,
		);
	}
	function complete(
		id: string,
		callerId: string | null,
		usage?: RequestData["usage"],
		overrides: Partial<Parameters<RequestRepository["save"]>[0]> = {},
	) {
		repository.save({
			id,
			callerId,
			method: "POST",
			path: "/v1/openai/responses",
			provider: "openai",
			upstreamPath: "/responses",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			timestamp: 1_500,
			usage,
			...overrides,
		});
	}
	it("adds nullable ownership without changing sparse old rows, and survives repeated migration and reopen", () => {
		const columns = db
			.query<{ name: string }, []>("PRAGMA table_info(requests)")
			.all();
		if (columns.some(({ name }) => name === "caller_id")) {
			db.run("ALTER TABLE requests DROP COLUMN caller_id");
		}
		db.run(
			"INSERT INTO requests (id, timestamp, method, path, total_tokens, input_tokens) VALUES ('old', 1500, 'POST', '/responses', NULL, NULL)",
		);
		runMigrations(db);
		runMigrations(db);
		expect(
			db
				.query(
					"SELECT id, timestamp, total_tokens, input_tokens, caller_id FROM requests",
				)
				.get(),
		).toEqual({
			id: "old",
			timestamp: 1_500,
			total_tokens: null,
			input_tokens: null,
			caller_id: null,
		});
		expect(
			db
				.query<{ name: string; notnull: number }, []>(
					"PRAGMA table_info(requests)",
				)
				.all()
				.filter(({ name }) => name === "caller_id"),
		).toEqual([expect.objectContaining({ name: "caller_id", notnull: 0 })]);
		complete("persisted", "agent-box", { totalTokens: 7 });
		db.close();
		db = new Database(databasePath);
		runMigrations(db);
		expect(
			db.query("SELECT id, caller_id FROM requests ORDER BY id").all(),
		).toEqual([
			{ id: "old", caller_id: null },
			{ id: "persisted", caller_id: "agent-box" },
		]);
	});
	it("retains the start owner including NULL, while completion without a start records its owner", () => {
		start("started", "alice");
		start("shared-key", null);
		complete("started", "bob", { totalTokens: 1 });
		complete("shared-key", "bob", { totalTokens: 2 });
		complete("completion-only", "agent-box", { totalTokens: 3 });
		expect(
			db.query("SELECT id, caller_id FROM requests ORDER BY id").all(),
		).toEqual([
			{ id: "completion-only", caller_id: "agent-box" },
			{ id: "shared-key", caller_id: null },
			{ id: "started", caller_id: "alice" },
		]);
		expect(repository.listSummaries()[0]).not.toHaveProperty("callerId");
	});
	it("sums successful and failed completions, excludes pending tokens and labels missing totals", () => {
		complete("success", "alice", {
			model: "model-a",
			inputTokens: 10,
			outputTokens: 4,
			cacheReadInputTokens: 2,
			cacheCreationInputTokens: 3,
			totalTokens: 25,
		});
		complete(
			"failed",
			"alice",
			{
				model: "model-a",
				inputTokens: 7,
				outputTokens: 1,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 2,
			},
			{ success: false, statusCode: 500 },
		);
		complete("unreported", "alice");
		start("pending", "alice");
		repository.updateUsage("pending", {
			model: "model-a",
			inputTokens: 100,
			totalTokens: 100,
		});
		complete("unattributed", null, { model: "model-b", totalTokens: 0 });
		const result = repository.getCallerUsage(window);
		expect(result.rows.find((row) => row.callerId === "alice")).toEqual({
			callerId: "alice",
			requests: 4,
			pendingRequests: 1,
			unreportedRequests: 2,
			inputTokens: 17,
			outputTokens: 5,
			cacheReadInputTokens: 7,
			cacheCreationInputTokens: 5,
			totalTokens: 40,
		});
		expect(result.rows.find((row) => row.callerId === null)).toEqual({
			callerId: null,
			requests: 1,
			pendingRequests: 0,
			unreportedRequests: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalTokens: 0,
		});
	});
	it("combines time, model and caller equality filters while listing models across the time window", () => {
		for (const [id, caller, model, timestamp] of [
			["before", "alice", "old-model", 900],
			["match", "alice", "model-a", 1_200],
			["other-caller", "bob", "model-a", 1_300],
			["other-model", "alice", "model-b", 1_400],
			["after", "alice", "future-model", 2_100],
		] as const) {
			complete(id, caller, { model, totalTokens: 3 }, { timestamp });
		}
		expect(
			repository.getCallerUsage({
				...window,
				model: "model-a",
				callerId: "alice",
			}),
		).toEqual({
			rows: [
				{
					callerId: "alice",
					requests: 1,
					pendingRequests: 0,
					unreportedRequests: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalTokens: 3,
				},
			],
			models: ["model-a", "model-b"],
		});
		expect(
			repository.getCallerUsage({ ...window, callerId: "alice' OR 1=1 --" })
				.rows,
		).toEqual([]);
	});
});
