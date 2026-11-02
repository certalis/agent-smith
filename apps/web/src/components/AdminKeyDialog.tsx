import { KeyRound, LockKeyhole, UnlockKeyhole } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function AdminKeyDialog() {
	const [isOpen, setIsOpen] = useState(false);
	const [adminKey, setAdminKey] = useState("");
	const [isUnlocked, setIsUnlocked] = useState(false);
	const [error, setError] = useState("");

	function close(): void {
		setIsOpen(false);
		setError("");
	}

	function submit(event: React.FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		const trimmedKey = adminKey.trim();
		if (!trimmedKey) {
			setError("Enter the server's admin key.");
			return;
		}

		api.setAdminKey(trimmedKey);
		setAdminKey("");
		setIsUnlocked(true);
		close();
	}

	function lock(): void {
		api.clearAdminKey();
		setAdminKey("");
		setIsUnlocked(false);
		close();
	}

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<Button
				variant={isUnlocked ? "secondary" : "outline"}
				className="w-full justify-start gap-3"
				onClick={() => setIsOpen(true)}
			>
				{isUnlocked ? (
					<UnlockKeyhole className="h-4 w-4" />
				) : (
					<LockKeyhole className="h-4 w-4" />
				)}
				{isUnlocked ? "Management unlocked" : "Unlock management"}
			</Button>
			<DialogContent>
				<form onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>Unlock management</DialogTitle>
						<DialogDescription>
							Enter the server's admin key to make dashboard changes. This key
							remains only in this tab and is cleared when you lock it or close
							the page.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2 py-4">
						<Label htmlFor="admin-key">Admin key</Label>
						<Input
							id="admin-key"
							type="password"
							autoComplete="off"
							value={adminKey}
							onChange={(event) => {
								setAdminKey(event.target.value);
								setError("");
							}}
							autoFocus
						/>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</div>
					<DialogFooter>
						{isUnlocked && (
							<Button type="button" variant="outline" onClick={lock}>
								<KeyRound className="h-4 w-4" />
								Lock management
							</Button>
						)}
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit">Unlock</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
