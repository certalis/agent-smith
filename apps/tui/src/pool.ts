import "./bundled-assets";
import startServer from "@agent-smith/runtime-server";

process.umask(0o077);
const server = startServer({
	port: Number(process.env.AGENT_SMITH_POOL_PORT),
	withDashboard: process.env.AGENT_SMITH_POOL_DASHBOARD === "1",
	additionalUnixSocket: process.env.AGENT_SMITH_STATE_DIR
		? `${process.env.AGENT_SMITH_STATE_DIR}/control.sock`
		: "/var/data/agent-smith/state/control.sock",
});
process.on("disconnect", () => {
	void server.stop().finally(() => process.exit(0));
});
process.send?.({ type: "ready", port: server.port });
