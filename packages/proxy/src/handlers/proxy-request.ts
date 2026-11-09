import type { Account, RequestMeta } from "@agent-smith/types";
import type { TeamRoutingRequest } from "../team-router";
import {
	type AccountSelectionOptions,
	getSoonestQuotaReset,
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
	const request = {
		body,
		ctx,
		mappedModel,
		meta,
		req,
		teamRequest,
		thread,
		url,
	};
	return {
		accounts: selectRequestAccounts(request, selectionOptions),
		request,
	};
}

/** A message-thread continuation must reach the seat that holds the thread. */
function onThreadSeat(request: ProxyRequest, accounts: Account[]): Account[] {
	const threadAccountId = getThreadBoundAccountId(
		request.ctx.messageThreads,
		request.thread,
	);
	return threadAccountId
		? accounts.filter((account) => account.id === threadAccountId)
		: accounts;
}

export function selectRequestAccounts(
	request: ProxyRequest,
	selectionOptions?: AccountSelectionOptions,
): Account[] {
	return onThreadSeat(
		request,
		selectAccountsForRequest(
			request.meta,
			request.ctx,
			request.teamRequest,
			selectionOptions,
		),
	);
}

/** When this request may retry: the soonest of its seats, one when a manual pin or a message thread binds it. */
export function getRequestRetryAt(request: ProxyRequest): number | null {
	const { ctx, teamRequest } = request;
	return getSoonestQuotaReset(request.meta, ctx, (fleet) =>
		onThreadSeat(
			request,
			ctx.teamRouter?.eligibleAccounts(
				fleet,
				teamRequest,
				ctx.runtime.teamRouting,
			) ?? fleet,
		),
	);
}
