import type { EnvEndpoint } from "./env-endpoint";
import type { EnvHost, EnvIdentity } from "./env-host";
import type { EnvPeer, Gateway } from "./gateway";
import { memoryLink } from "./link-end";

/** Both ends of the gateway machine's own link; `close()` ends it. */
export interface LocalEnv {
	peer: EnvPeer;
	endpoint: EnvEndpoint;
	close(): void;
}

/**
 * Registers this process's environment with its own gateway through the same interface a remote daemon uses
 * (`Gateway.attachEnv` on one end, `EnvHost.attach` on the other), over an in-process link instead of a socket. The
 * gateway machine's `name` is its own configured name; there is no key to prove and no heartbeat to run.
 */
export function registerLocalEnv(gateway: Gateway, host: EnvHost, identity: EnvIdentity, name: string): LocalEnv {
	const [envEnd, gatewayEnd] = memoryLink();
	const peer = gateway.attachEnv({ ...identity, name, acceptsBroker: true }, gatewayEnd);
	gatewayEnd.sink = { onMessage: text => peer.receive(text), onClose: () => peer.closed() };
	const endpoint = host.attach(envEnd);
	envEnd.sink = { onMessage: text => endpoint.receive(text), onClose: () => host.detach(endpoint) };
	gateway.peerReady(peer);
	return { peer, endpoint, close: () => envEnd.close() };
}
