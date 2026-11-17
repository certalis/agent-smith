import { isTimeRange, type TimeRange } from "@agent-smith/types";
import { TIME_RANGE_OPTIONS } from "@agent-smith/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useCallerUsage } from "../hooks/use-caller-usage";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

const count = (value: number) => value.toLocaleString("en-US");
const tokenFields = [
	"inputTokens",
	"cacheReadInputTokens",
	"cacheCreationInputTokens",
	"outputTokens",
	"totalTokens",
] as const;

export function CallerUsageTab() {
	const [range, setRange] = useState<TimeRange>("24h");
	const [model, setModel] = useState("");
	const { data, error, isLoading, isFetching, refetch, unlocked } =
		useCallerUsage(range, model);
	if (!unlocked)
		return (
			<Card>
				<CardHeader>
					<CardTitle>Administrator access required</CardTitle>
					<CardDescription>
						Use “Unlock management” in the sidebar to view users’ token usage.
						Device and shared proxy keys cannot read this report.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	return (
		<Card>
			<CardHeader className="gap-4">
				<div>
					<CardTitle>Users and services</CardTitle>
					<CardDescription>
						Who consumed tokens, regardless of which subscription served the
						request.
					</CardDescription>
				</div>
				<div className="flex flex-wrap items-end gap-4">
					<div className="grid gap-2">
						<Label htmlFor="usage-range">Time range</Label>
						<Select
							value={range}
							onValueChange={(value) => {
								if (isTimeRange(value)) setRange(value);
							}}
						>
							<SelectTrigger id="usage-range" className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TIME_RANGE_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="usage-model">Model</Label>
						<Select
							value={model ? `model:${model}` : "all"}
							onValueChange={(value) =>
								setModel(value === "all" ? "" : value.slice(6))
							}
						>
							<SelectTrigger id="usage-model" className="w-56">
								<SelectValue placeholder="All models" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All models</SelectItem>
								{[
									...new Set([
										...(data?.models ?? []),
										...(model ? [model] : []),
									]),
								].map((name) => (
									<SelectItem key={name} value={`model:${name}`}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<Button
						variant="outline"
						disabled={isFetching}
						onClick={() => {
							void refetch();
						}}
					>
						<RefreshCw className="h-4 w-4" />
						{isFetching ? "Refreshing…" : "Refresh"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{error ? (
					<p role="alert" className="text-sm text-destructive">
						Could not read usage. Check the administrator key and refresh.
					</p>
				) : isLoading ? (
					<p role="status" className="text-sm text-muted-foreground">
						Loading token usage…
					</p>
				) : !data?.rows.length ? (
					<p className="text-sm text-muted-foreground">
						No requests recorded in this time range for the selected model.
						Assign a distinct device key to each user or service to identify new
						requests.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<caption className="sr-only">
								Recorded token usage by user or service
							</caption>
							<thead>
								<tr className="border-b text-muted-foreground">
									{[
										"User / service",
										"Requests",
										"Input",
										"Cache read",
										"Cache write",
										"Output",
										"Total tokens",
									].map((name, index) => (
										<th
											scope="col"
											key={name}
											className={`px-3 py-3 font-medium whitespace-nowrap ${index === 0 ? "text-left" : "text-right"}`}
										>
											{name}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row) => (
									<tr
										key={
											row.callerId === null
												? "unattributed"
												: `caller:${row.callerId}`
										}
										className="border-b last:border-0"
									>
										<th
											scope="row"
											className="px-3 py-4 text-left font-medium whitespace-nowrap"
										>
											{row.callerId ?? "Unattributed"}
											{row.callerId === null && (
												<p className="mt-1 font-normal text-xs text-muted-foreground">
													Older requests or shared access
												</p>
											)}
										</th>
										<td className="px-3 py-4 text-right tabular-nums">
											{count(row.requests)}
											{row.pendingRequests > 0 && (
												<p className="text-xs text-muted-foreground whitespace-nowrap">
													{count(row.pendingRequests)} pending
												</p>
											)}
											{row.unreportedRequests > 0 && (
												<p className="text-xs text-muted-foreground whitespace-nowrap">
													{count(row.unreportedRequests)} missing totals
												</p>
											)}
										</td>
										{tokenFields.map((field) => (
											<td
												key={field}
												className={`px-3 py-4 text-right tabular-nums ${field === "totalTokens" ? "font-semibold" : ""}`}
											>
												{count(row[field])}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<p className="text-xs text-muted-foreground">
					Input excludes cache reads and writes. Interrupted replies can have
					incomplete counts. This report covers retained requests through this
					pool—not subscription quota or usage made elsewhere.
				</p>
			</CardContent>
		</Card>
	);
}
