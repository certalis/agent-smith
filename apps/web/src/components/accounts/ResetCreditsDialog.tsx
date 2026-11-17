import type { AccountResponse } from "@agent-smith/api";
import { useResetCredits } from "../../hooks/useResetCredits";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

export function ResetCreditsDialog({
	account,
	onClose,
}: {
	account: AccountResponse;
	onClose: () => void;
}) {
	const { credits, consume, selected, pendingId, select } = useResetCredits(
		account.id,
	);
	const result = consume.data;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !consume.isPending) onClose();
			}}
		>
			<DialogContent
				className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto"
				aria-busy={consume.isPending}
			>
				<DialogHeader>
					<DialogTitle>Usage resets · {account.name}</DialogTitle>
					<DialogDescription>
						These are limited Codex grants, not paid credits. A reset is used
						only when you confirm it here. Account pauses and pool limits stay
						unchanged.
					</DialogDescription>
				</DialogHeader>
				{credits.isPending && <p role="status">Checking available resets…</p>}
				{credits.error && (
					<p role="alert">
						Could not check resets. Unlock administrator access and try again.
					</p>
				)}
				{credits.data && (
					<>
						<p>{credits.data.availableCount} reset(s) available</p>
						{credits.data.credits.map((credit) => {
							const available =
								credit.status === "available" &&
								credit.resetType === "codex_rate_limits" &&
								(credit.expiresAt === null ||
									Date.parse(credit.expiresAt) > Date.now());
							return (
								<div key={credit.id} className="space-y-2 border-t pt-3">
									<p className="font-medium">
										{credit.title || "Codex usage reset"}
									</p>
									{credit.description && (
										<p className="text-sm">{credit.description}</p>
									)}
									<p className="text-sm text-muted-foreground">
										{credit.status} ·{" "}
										{credit.expiresAt
											? `Expires ${new Date(credit.expiresAt).toLocaleString()}`
											: "No expiration reported"}
									</p>
									<Button
										variant="outline"
										disabled={
											!available || consume.isPending || pendingId !== null
										}
										onClick={() => select(credit)}
									>
										Use this reset
									</Button>
								</div>
							);
						})}
						{credits.data.credits.length < credits.data.availableCount && (
							<p className="text-sm">
								The provider did not list every available reset. Refresh to
								check again; no reset will be chosen automatically.
							</p>
						)}
					</>
				)}
				{selected && (
					<div className="space-y-3 rounded border border-warning p-3">
						{pendingId && (
							<p role="status">
								A previous attempt has no confirmed result yet. Retry that same
								reset to check its outcome.
							</p>
						)}
						<p>
							Use one reset for <strong>{account.name}</strong>? The provider
							decides which allowances it restores. This cannot be undone.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={consume.isPending}
								onClick={() => consume.mutate(selected)}
							>
								{consume.isPending
									? "Using reset…"
									: pendingId
										? "Retry the same reset"
										: "Confirm use of one reset"}
							</Button>
							<Button
								variant="outline"
								disabled={consume.isPending || pendingId !== null}
								onClick={() => select(null)}
							>
								Cancel
							</Button>
						</div>
					</div>
				)}
				{consume.error && (
					<p role="alert">
						The result could not be confirmed. Retry the same reset; do not use
						another one to test. No automatic retry was sent.
					</p>
				)}
				{result && (
					<p role="status">
						{result.code === "reset"
							? "Reset used."
							: result.code === "already_redeemed"
								? "This reset was already used."
								: result.code === "nothing_to_reset"
									? "No allowance needed a reset. No reset was used."
									: "No reset was available."}{" "}
						{(result.code === "reset" || result.code === "already_redeemed") &&
						!result.quotaRefreshed
							? "Current quota could not be refreshed; saved limits remain in place."
							: ""}
					</p>
				)}
				<Button
					variant="outline"
					disabled={consume.isPending}
					onClick={() => {
						void credits.refetch();
					}}
				>
					Refresh available resets
				</Button>
			</DialogContent>
		</Dialog>
	);
}
