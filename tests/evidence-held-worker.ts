// Real subprocess fixture for the owner's cancellation and kill/wait proofs; never imported by application code.
await new Promise<void>(() => { setInterval(() => {}, 1_000); });
