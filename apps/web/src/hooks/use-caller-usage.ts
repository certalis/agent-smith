import type { TimeRange } from "@agent-smith/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import { queryKeys } from "../lib/query-keys";

/** A lock or key change hides old private results before fetching anything new. */
export function useCallerUsage(range: TimeRange, model: string) {
	const revision = useSyncExternalStore(
		api.subscribeAdminKey,
		api.getAdminKeyRevision,
	);
	const unlocked = api.hasAdminKey();
	const client = useQueryClient();
	useEffect(
		() => () => {
			client.removeQueries({ queryKey: queryKeys.callerUsage(revision) });
		},
		[client, revision],
	);
	const result = useQuery({
		queryKey: [...queryKeys.callerUsage(revision), range, model],
		queryFn: ({ signal }) => api.getCallerUsage({ range, model }, signal),
		enabled: unlocked,
		retry: false,
	});
	return { ...result, unlocked };
}
