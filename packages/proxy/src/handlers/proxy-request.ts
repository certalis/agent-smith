import type { Account, RequestMeta } from "@ccflare/types";
import type { TeamRoutingRequest } from "../team-router";
import {
	type AccountSelectionOptions,
	selectAccountsForRequest,
} from "./account-selector";
import {
	getThreadBoundAccountId,
	type MessageThreadRequest,
	parseMessageThreadRequest,
} from "./message-thread";
import type { ResolvedProxyContext } from "./proxy-types";

export type ProxyRequest = {
	body: ArrayBuffer | null;
	ctx: ResolvedProxyContext;
	mappedModel: string | undefined;
	meta: RequestMeta;
	req: Request;
	teamRequest: TeamRoutingRequest;
	thread: MessageThreadRequest | null;
	url: URL;
};

export function prepareProxyRequest(
	req: Request,
	url: URL,
	ctx: ResolvedProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	manualAccountName?: string,
	teamRequestOverride?: TeamRoutingRequest,
	mappedModel: string | undefined = undefined,
	selectionOptions?: AccountSelectionOptions,
): { accounts: Account[]; request: ProxyRequest } {
	const thread = parseMessageThreadRequest(
		body,
		ctx.upstreamPath,
		req.headers.get("content-type"),
		ctx.provider.getClientSessionId?.(req.headers) ?? null,
	);
	const sessionId = ctx.provider.getClientSessionId?.(req.headers) ?? null;
	const teamRequest = teamRequestOverride ?? {
		body,
		contentType: req.headers.get("content-type"),
		manualAccountName,
		model: meta.model,
		provider: ctx.providerName,
		sessionId,
	};
	const selectedAccounts = selectAccountsForRequest(
		meta,
		ctx,
		teamRequest,
		selectionOptions,
	);
	const threadAccountId = getThreadBoundAccountId(ctx.messageThreads, thread);
	const accounts = threadAccountId
		? selectedAccounts.filter((account) => account.id === threadAccountId)
		: selectedAccounts;
	return {
		accounts,
		request: {
			body,
			ctx,
			mappedModel,
			meta,
			req,
			teamRequest,
			thread,
			url,
		},
	};
}
