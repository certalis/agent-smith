import type { RequestStep, Scenario, UpstreamRule } from "./scenario";

export type WireRequest = {
	body: string;
	headers: Record<string, string>;
	method: string;
	path: string;
	upload?: RequestStep["upload"];
};

export type WireClientResult = {
	body: string;
	chunks: string[];
	headers: Record<string, string>;
	status: number;
	uploadCompleted: boolean;
	uploadedBytes: number;
	uploadBufferedBytes: number;
	cancelled: boolean;
};

export type WireCommand =
	| { type: "initialize"; rules: UpstreamRule[]; tokens: [string, string][] }
	| { type: "edge"; socketPath: string; options: Scenario["edge"] }
	| { type: "request"; clientId: string; request: WireRequest }
	| { type: "client-chunk" | "cancel"; clientId: string }
	| { type: "release"; ruleId: string }
	| { type: "stop" };

export type WireEvent =
	| { type: "reply"; id: string; value?: unknown; error?: string }
	| {
			type: "upstream-request";
			index: number;
			account?: string;
			body: string;
			headers: Record<string, string>;
			method: string;
			path: string;
	  }
	| { type: "upstream-closed"; index: number; responseEnded: boolean }
	| { type: "connection" };
