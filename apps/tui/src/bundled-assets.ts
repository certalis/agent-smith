import { join } from "node:path";

// The published bundle ships the dashboard and the usage worker beside itself.
process.env.AGENT_SMITH_DASHBOARD_DIST_DIR ??= join(
	import.meta.dir,
	"dashboard",
);
process.env.AGENT_SMITH_USAGE_WORKER_PATH ??= join(
	import.meta.dir,
	"post-processor.worker.js",
);
