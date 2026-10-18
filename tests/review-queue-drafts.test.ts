import { describe, expect, test } from "bun:test";
import { ReviewDrafts } from "../app/src/components/review-queues/drafts";
import { ReviewRequestError } from "../app/src/components/review-queues/client";
import type { ReviewItem } from "../src/review-queues/protocol";
const item = (id = "A"): ReviewItem => ({ id, queueId: "q", ordinal: 1, revision: 1, state: "draft", draft: { name: id, input: null, tags: [], note: "", target: {} } } as ReviewItem);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const changed = (value: ReviewItem, target: string) => ({ ...value.draft, target: { expectedOutput: target } });

describe("bounded per-item UI drafts", () => {
  test("edit A then B inside debounce persists both independently", async () => {
    const writes: string[] = [];
    const state = new ReviewDrafts({ window: async () => [item()], mutate: async (_q, id, _kind, request) => { writes.push(id); return { ...item(id), draft: request.draft!, revision: 2 }; } }, 5);
    state.edit(item("A"), changed(item("A"), "A target")); state.edit(item("B"), changed(item("B"), "B target"));
    await new Promise(resolve => setTimeout(resolve, 30)); expect(writes.sort()).toEqual(["A", "B"]); expect(state.dirtyCount).toBe(0); state.dispose();
  });
  test("newer local edit survives delayed save acknowledgment; immediate approval uses latest edit and acknowledged revision", async () => {
    const first = deferred<ReviewItem>(), writes: Array<{ kind: string; target: unknown; revision: number }> = []; let count = 0;
    const state = new ReviewDrafts({ window: async () => [item()], mutate: async (_q, _id, kind, request) => {
      writes.push({ kind, target: request.draft?.target.expectedOutput, revision: request.expectedRevision });
      if (++count === 1) return first.promise;
      return { ...item(), draft: request.draft!, revision: request.expectedRevision + 1, state: kind === "approve" ? "approved" : "draft" };
    } }, 10000);
    state.edit(item(), changed(item(), "old edit")); const saving = state.save("A");
    state.edit(item(), changed(item(), "latest edit")); const approving = state.approve(item());
    first.resolve({ ...item(), draft: changed(item(), "old edit"), revision: 2 }); await saving; const result = await approving;
    expect(writes).toEqual([{ kind: "save", target: "old edit", revision: 1 }, { kind: "approve", target: "latest edit", revision: 2 }]);
    expect(result.draft.target.expectedOutput).toBe("latest edit"); expect(result.state).toBe("approved"); expect(state.dirtyCount).toBe(0); state.dispose();
  });
  test("failed acknowledgment retains exact retry payload and newer draft; dirty hydration cannot overwrite it", async () => {
    const requests: unknown[] = []; let fail = true;
    const state = new ReviewDrafts({ window: async () => [item()], mutate: async (_q, _id, _kind, request) => { requests.push(request); if (fail) throw new TypeError("Network lost"); return { ...item(), draft: request.draft!, revision: request.expectedRevision + 1 }; } }, 10000);
    state.edit(item(), changed(item(), "first")); await state.save("A");
    state.edit(item(), changed(item(), "newer")); state.hydrate({ ...item(), draft: changed(item(), "stale server") });
    expect(state.entries.get("A")!.draft.target.expectedOutput).toBe("newer"); expect(state.dirtyCount).toBe(1);
    fail = false; await state.retry("A"); expect(requests[0]).toEqual(requests[1]); expect((requests[2] as { draft: { target: unknown } }).draft.target).toEqual({ expectedOutput: "newer" }); expect(state.dirtyCount).toBe(0); state.dispose();
  });
  test("lost acknowledgment fetches the actual row and recognizes the original committed mutation", async () => {
    let stored = item(), calls = 0;
    const state = new ReviewDrafts({ window: async () => [stored], mutate: async (_q,_id,_kind,request) => {
      calls++; stored = { ...stored,draft:request.draft!,revision:request.expectedRevision+1,lastMutationId:request.mutationId };
      throw new TypeError("Response lost after server commit");
    } }, 10000);
    state.edit(item(),changed(item(),"Committed once")); await state.save("A");
    expect(calls).toBe(1); expect(stored.draft.target.expectedOutput).toBe("Committed once"); expect(state.dirtyCount).toBe(0); state.dispose();
  });
  test("conflicts block approval until explicit latest-revision reapply and 16 retained drafts block a seventeenth", async () => {
    const state = new ReviewDrafts({ window: async () => [item()], mutate: async () => { throw new ReviewRequestError("Changed elsewhere", 409, "revision_conflict"); } }, 10000);
    state.edit(item(), changed(item(), "retained")); await state.save("A"); let conflict = ""; try { await state.approve(item()); } catch (failure) { conflict = (failure as Error).message; } expect(conflict).toBe("Changed elsewhere");
    expect(state.entries.get("A")!.draft.target.expectedOutput).toBe("retained");
    state.reapply("A", { ...item(), revision: 9 }); expect(state.entries.get("A")!.server.revision).toBe(9);
    for (let n = 1; n < 16; n++) state.edit(item(String(n)), changed(item(String(n)), "retained"));
    expect(() => state.edit(item("seventeenth"), changed(item(), "blocked"))).toThrow("16 drafts"); expect(state.entries.size).toBe(16); state.dispose();
  });
});
