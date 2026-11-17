import { createHash } from "node:crypto";
import {
	type ClientAssertion,
	defineScenario,
	type RequestStep,
} from "./harness/scenario";
import {
	wireAdminKey,
	wireDeviceKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const label = "Shared_1-service";
const header = "x-agent-smith-caller";
const body = '{"model":"synthetic-model","messages":[]}';
const invalid = ["", "has space", "comma,combined", "x".repeat(65)];
const inference = (key: string | null, value: string): RequestStep => ({
	type: "request",
	id: key === null || key === "invalid-key" ? "denied" : "accepted",
	body,
	headers: { ...(key === null ? {} : { "x-api-key": key }), [header]: value },
});
const report = (id: string, caller?: string): RequestStep => ({
	type: "request",
	id,
	transport: "unix",
	method: "GET",
	path: `/api/usage/callers?range=24h${caller ? `&caller=${encodeURIComponent(caller)}` : ""}`,
	body: "",
	headers: { "x-api-key": wireAdminKey },
});
const fields = (
	request: string,
	values: Record<string, unknown>,
): ClientAssertion[] =>
	Object.entries(values).map(([path, value]) => ({
		id: `${request}-${path}`,
		type: "client",
		request,
		status: 200,
		jsonPath: { path, value },
	}));

// Cases: edge label counts; device precedence/name collision; ignored malformed or
// duplicate labels; unchanged auth; durable filtering; upstream/metadata stripping.
export default defineScenario({
	name: "self-reported caller labels count privately without changing authentication",
	edge: {},
	deviceKeys: {
		[label]: createHash("sha256").update(wireDeviceKey).digest("hex"),
	},
	config: {
		payload_storage_enabled: true,
		team_routing: { enabled: false, quota_probe_seconds: 0 },
	},
	fleet: [{ name: "pooled-seat" }],
	upstream: [
		{
			account: "pooled-seat",
			status: 200,
			json: {
				model: "synthetic-model",
				usage: { input_tokens: 11, output_tokens: 4 },
			},
		},
	],
	steps: [
		{ ...inference(wireProxyKey, label), transport: "edge" },
		inference(wireProxyKey, "second"),
		inference(wireDeviceKey, label),
		inference(wireDeviceKey, "second"),
		...invalid.map((value) => inference(wireProxyKey, value)),
		{
			...inference(wireProxyKey, "duplicate-one"),
			headers: {
				"x-api-key": wireProxyKey,
				[header]: "duplicate-one",
				"X-Agent-Smith-Caller": "duplicate-two",
			},
		},
		inference(null, label),
		inference("invalid-key", label),
		{ type: "flush", usageWorker: true },
		{ type: "restart" },
		report("all"),
		report("claimed", `label:${label}`),
		report("verified", label),
		report("second", "label:second"),
		...["/api/requests", "/api/requests/detail"].map(
			(path): RequestStep => ({
				...report("metadata"),
				path,
			}),
		),
	],
	assertions: [
		{
			id: "valid-key-label-errors-do-not-break-inference",
			type: "client",
			request: "accepted",
			status: 200,
		},
		{
			id: "labels-cannot-authenticate",
			type: "client",
			request: "denied",
			statuses: [401, 401],
		},
		{
			id: "provider-never-sees-labels-or-rewritten-bodies",
			type: "upstream",
			count: 9,
			bodyIdentical: body,
			headerAbsent: header,
		},
		...fields("all", {
			"rows.length": 4,
			"rows.0.callerId": null,
			"rows.0.requests": 5,
		}),
		...fields("claimed", {
			"rows.length": 1,
			"rows.0.callerId": `label:${label}`,
			"rows.0.requests": 1,
			"rows.0.totalTokens": 15,
		}),
		...fields("verified", {
			"rows.length": 1,
			"rows.0.callerId": label,
			"rows.0.requests": 2,
			"rows.0.totalTokens": 30,
		}),
		...fields("second", {
			"rows.length": 1,
			"rows.0.requests": 1,
			"rows.0.totalTokens": 15,
		}),
		{
			id: "ordinary-metadata-never-exposes-labels",
			type: "client",
			request: "metadata",
			status: 200,
			bodyExcludes: [
				header,
				"X-Agent-Smith-Caller",
				"label:",
				label,
				"duplicate-one",
				"duplicate-two",
			],
		},
	],
});
