import type { ResetCredit } from "@agent-smith/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../lib/query-keys";
import {
	beginResetAttempt,
	completeResetAttempt,
	loadResetAttempt,
} from "../lib/reset-attempt";

export function useResetCredits(accountId: string) {
	const client = useQueryClient();
	const [pendingId, setPendingId] = useState<string | null>(() => {
		try {
			return loadResetAttempt(sessionStorage, accountId)?.creditId ?? null;
		} catch {
			return null;
		} // Saving/validating again must succeed before any POST.
	});
	const [selected, setSelected] = useState<ResetCredit | null>(() =>
		pendingId
			? {
					id: pendingId,
					title: "Pending reset",
					description: null,
					resetType: "codex_rate_limits",
					status: "pending",
					grantedAt: "",
					expiresAt: null,
				}
			: null,
	);
	const credits = useQuery({
		queryKey: ["reset-credits", accountId],
		queryFn: () => api.getResetCredits(accountId),
		retry: false,
		staleTime: 0,
	});
	const consume = useMutation({
		mutationFn: async (credit: ResetCredit) => {
			// Persist before sending: reopening after a lost reply retries the same operation.
			const attempt = beginResetAttempt(sessionStorage, accountId, credit.id);
			setPendingId(credit.id);
			const result = await api.consumeResetCredit(accountId, attempt);
			completeResetAttempt(sessionStorage, accountId);
			setPendingId(null);
			return result;
		},
		retry: false,
		onSuccess: () => {
			setSelected(null);
			void credits.refetch();
			void client.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
	return {
		credits,
		consume,
		selected,
		pendingId,
		select: (credit: ResetCredit | null) => {
			if (pendingId && credit?.id !== pendingId) return;
			consume.reset();
			setSelected(credit);
		},
	};
}
