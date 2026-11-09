export {
	createServerFetchHandler,
	createStartupBanner,
	default,
	type ServerHandle,
	type StartServerOptions,
} from "@agent-smith/runtime-server";

import startServer from "@agent-smith/runtime-server";

if (import.meta.main) {
	startServer();
}
