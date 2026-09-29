import type { DomObservable } from "./dom.js";
import type { NetworkObservable } from "./network.js";
import type { ProbeObservable } from "./probe.js";

export type ObservableSpec = { dom: DomObservable } | { network: NetworkObservable } | { probe: ProbeObservable };
