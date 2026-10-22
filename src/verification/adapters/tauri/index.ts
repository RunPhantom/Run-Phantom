/** Tauri-only typed registration surface; importing this does not activate a runtime. */
export { CooperatingTauriAdapter } from "./adapter";
export { TauriArtifactStore } from "./artifacts";
export { TauriProcessTransport } from "./process-transport";
export { TAURI_LIMITS, TauriError } from "./contract";
export type { TauriAuthority, TauriRequest, TauriReply, TauriObservation, TauriTransport } from "./contract";
