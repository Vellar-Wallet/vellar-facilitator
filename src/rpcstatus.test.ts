import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturedRpcStatus,
  installRpcStatusCapture,
  withRpcStatusCapture,
  __resetRpcStatusCaptureForTest,
  __setRpcRetryDelayForTest,
} from "./rpcstatus.js";

// ============================================================================
// THE GUARD. This file is the condition of merge for the monkey-patch in
// rpcstatus.ts, and its job is to make a SILENT failure impossible.
//
// If @stellar/stellar-sdk renames sendTransaction, or @x402/stellar stops using
// rpc.Server, the capture stops working and error bodies quietly lose their RPC
// status. Nobody would notice: settlements still succeed, failures still fail,
// and the only difference is a diagnostic that is no longer there. That is the
// exact class of defect this codebase keeps finding — a control that degrades
// invisibly. These tests turn it into a red build.
//
// The concurrency test matters MORE than the capture test. A leak between
// requests does not lose a diagnostic, it produces a WRONG one presented as
// real: request A's TRY_AGAIN_LATER reported on request B's failure would tell a
// developer to retry a payload that is actually stale. Losing information is
// recoverable; inventing it is not.
// ============================================================================

/** Install over a stub so the tests never touch a network. */
function withStubbedSend(
  impl: (tx: unknown) => Promise<Record<string, unknown>>,
): { logs: string[]; restore: () => void } {
  const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
  const original = proto.sendTransaction;
  proto.sendTransaction = impl;
  const logs: string[] = [];
  __resetRpcStatusCaptureForTest();
  installRpcStatusCapture((m) => logs.push(m));
  // The submission retry's 6s spacing is real time; tests run it at zero. The
  // retry BEHAVIOUR (counts, scoping, falsifier) is asserted below — only the
  // wall-clock is stubbed.
  __setRpcRetryDelayForTest(async () => {});
  return {
    logs,
    restore: () => {
      proto.sendTransaction = original;
      __resetRpcStatusCaptureForTest();
      __setRpcRetryDelayForTest();
    },
  };
}

const server = () => new rpc.Server("https://rpc.invalid", { allowHttp: false });

afterEach(() => vi.restoreAllMocks());

describe("capture — the diagnostic actually arrives", () => {
  it("records a non-PENDING status raised inside library code we do not control", async () => {
    // MUTATION THAT MUST BREAK THIS: remove the `slot.captured = …` assignment,
    // or stop wrapping the settle call in withRpcStatusCapture. The status is
    // then absent and every submission failure looks identical again — the
    // situation this whole file exists to prevent.
    const h = withStubbedSend(async () => ({ status: "TRY_AGAIN_LATER", latestLedger: 4085901 }));
    try {
      const { value, rpcStatus } = await withRpcStatusCapture(async () => {
        // Stands in for @x402/stellar: it calls sendTransaction, throws the
        // response away, and returns its own constant.
        await server().sendTransaction({} as never);
        return { success: false, errorReason: "settle_exact_stellar_transaction_submission_failed" };
      });
      expect(value.success).toBe(false);
      expect(rpcStatus, "the RPC's answer must survive the library discarding it").toEqual({
        status: "TRY_AGAIN_LATER",
        latestLedger: 4085901,
      });
    } finally {
      h.restore();
    }
  });

  it("decodes the error code when the RPC supplies one", async () => {
    // txBadSeq and TRY_AGAIN_LATER need OPPOSITE responses from a caller, so the
    // code is the part that carries the meaning.
    //
    // MUTATION: return undefined from decodeErrorCode. The caller can no longer
    // distinguish "retry" from "this payload is stale", which is the entire
    // point of surfacing anything.
    const h = withStubbedSend(async () => ({
      status: "ERROR",
      errorResult: { result: () => ({ switch: () => ({ name: "txBadSeq" }) }) },
    }));
    try {
      const { rpcStatus } = await withRpcStatusCapture(async () => {
        await server().sendTransaction({} as never);
      });
      expect(rpcStatus?.errorCode).toBe("txBadSeq");
    } finally {
      h.restore();
    }
  });

  it("PENDING is not recorded — a successful submission has nothing to explain", async () => {
    // MUTATION: drop the `status !== "PENDING"` guard. Every successful settle
    // then carries a pointless rpcStatus, and the field stops meaning
    // "something went wrong".
    const h = withStubbedSend(async () => ({ status: "PENDING", hash: "abc" }));
    try {
      const { rpcStatus } = await withRpcStatusCapture(async () => {
        await server().sendTransaction({} as never);
      });
      expect(rpcStatus).toBeUndefined();
    } finally {
      h.restore();
    }
  });

  it("a throw inside the recorder never breaks the settlement", async () => {
    // Diagnostics must not be able to fail a payment. MUTATION: remove the
    // try/catch in the patch — a malformed response then throws through
    // sendTransaction and takes the settle with it.
    const h = withStubbedSend(async () => ({
      status: "ERROR",
      get errorResult(): never {
        throw new Error("hostile getter");
      },
    }));
    try {
      await expect(
        withRpcStatusCapture(async () => {
          await server().sendTransaction({} as never);
          return "settled";
        }),
      ).resolves.toMatchObject({ value: "settled" });
    } finally {
      h.restore();
    }
  });
});

describe("isolation — a wrong diagnostic is worse than none", () => {
  it("concurrent requests never see each other's status", async () => {
    // THE TEST THAT MATTERS MOST.
    //
    // MUTATION THAT MUST BREAK THIS: replace the AsyncLocalStorage slot with a
    // module-level `let lastCaptured`. Ten interleaved requests then all report
    // whichever status was written last, so a caller whose payload was stale
    // (txBadSeq) is told TRY_AGAIN_LATER and retries something that can never
    // succeed — a confident, wrong instruction.
    //
    // The stub interleaves deliberately: each call yields before returning, so
    // the requests are genuinely overlapping rather than accidentally serial.
    const h = withStubbedSend(async (tx) => {
      const id = (tx as { id: number }).id;
      await new Promise((r) => setTimeout(r, id % 3));
      return id % 2 === 0
        ? { status: "TRY_AGAIN_LATER", latestLedger: 1000 + id }
        : { status: "ERROR", errorResult: { result: () => ({ switch: () => ({ name: `code${id}` }) }) } };
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, id) =>
          withRpcStatusCapture(async () => {
            await server().sendTransaction({ id } as never);
            // Yield again AFTER capture, so a leak has every chance to happen.
            await new Promise((r) => setTimeout(r, (10 - id) % 4));
            return { id, captured: capturedRpcStatus() };
          }),
        ),
      );

      for (const { value: { id, captured } } of results) {
        if (id % 2 === 0) {
          expect(captured, `request ${id} must see its OWN status`).toEqual({
            status: "TRY_AGAIN_LATER",
            latestLedger: 1000 + id,
          });
        } else {
          expect(captured?.status, `request ${id}`).toBe("ERROR");
          expect(captured?.errorCode, `request ${id} must see its OWN error code`).toBe(`code${id}`);
        }
      }
    } finally {
      h.restore();
    }
  });

  it("a request that captured nothing does not inherit an earlier one's status", async () => {
    // MUTATION: same module-level variable. A settle that succeeds after an
    // earlier failure would report the earlier failure's status — attaching a
    // diagnostic to a request that had no problem at all.
    const h = withStubbedSend(async (tx) =>
      (tx as { fail: boolean }).fail ? { status: "TRY_AGAIN_LATER" } : { status: "PENDING", hash: "ok" },
    );
    try {
      await withRpcStatusCapture(async () => {
        await server().sendTransaction({ fail: true } as never);
      });
      const second = await withRpcStatusCapture(async () => {
        await server().sendTransaction({ fail: false } as never);
      });
      expect(second.rpcStatus, "a clean request carries no status").toBeUndefined();
    } finally {
      h.restore();
    }
  });

  it("outside a capture scope, recording is a no-op rather than a crash", async () => {
    // Anything settling outside the route (a script, a test) must not throw.
    const h = withStubbedSend(async () => ({ status: "TRY_AGAIN_LATER" }));
    try {
      await expect(server().sendTransaction({} as never)).resolves.toMatchObject({
        status: "TRY_AGAIN_LATER",
      });
      expect(capturedRpcStatus(), "no scope, no status").toBeUndefined();
    } finally {
      h.restore();
    }
  });

  it("the status can only be read where it is valid — the API shape enforces it", async () => {
    // REGRESSION GUARD for a defect this file caught: the first version exposed
    // capturedRpcStatus() as the way to read the result, and the natural call
    // site — immediately after `await withRpcStatusCapture(...)` — is OUTSIDE
    // the scope, so it returned undefined and the mechanism did nothing in
    // production while every capture test passed.
    //
    // MUTATION: make withRpcStatusCapture return the bare value again. The
    // server then has nowhere valid to read from, and this fails.
    const h = withStubbedSend(async () => ({ status: "DUPLICATE" }));
    try {
      const out = await withRpcStatusCapture(async () => {
        await server().sendTransaction({} as never);
        return "done";
      });
      expect(out).toHaveProperty("value", "done");
      expect(out).toHaveProperty("rpcStatus");
      expect(out.rpcStatus?.status).toBe("DUPLICATE");
      // ...and reading it the old way, after the scope, gives nothing.
      expect(capturedRpcStatus()).toBeUndefined();
    } finally {
      h.restore();
    }
  });
});

describe("the patch announces itself", () => {
  it("logs what it wraps and why, so it is not the next person's mystery", async () => {
    // MUTATION: delete the log call. The patch becomes invisible, and the next
    // person debugging odd sendTransaction behaviour has no thread to pull.
    const lines: string[] = [];
    const h = withStubbedSend(async () => ({ status: "PENDING" }));
    h.restore();
    __resetRpcStatusCaptureForTest();
    const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
    const original = proto.sendTransaction;
    installRpcStatusCapture((m) => lines.push(m));
    proto.sendTransaction = original;
    __resetRpcStatusCaptureForTest();

    expect(lines.length, "installation must be announced").toBe(1);
    expect(lines[0]).toMatch(/MONKEY-PATCH INSTALLED/);
    expect(lines[0], "names what it wraps").toMatch(/sendTransaction/);
    expect(lines[0], "names why").toMatch(/single constant|indistinguishable/);
    expect(lines[0], "names the guard, so a reader can check it still works").toMatch(/rpcstatus\.test/);
  });
});


describe("submission retry — TRY_AGAIN_LATER only, bounded, falsifier-logged", () => {
  function seqStub(seq: Array<Record<string, unknown>>) {
    let n = 0;
    const calls = () => n;
    const h = withStubbedSend(async () => seq[Math.min(n++, seq.length - 1)]!);
    return { h, calls };
  }
  const send = () =>
    withRpcStatusCapture(async () => server().sendTransaction({} as never));

  it("retries TRY_AGAIN_LATER and succeeds when the RPC recovers", async () => {
    const { h, calls } = seqStub([{ status: "TRY_AGAIN_LATER" }, { status: "PENDING", hash: "h" }]);
    try {
      const { value, rpcStatus } = await send();
      expect((value as { status: string }).status).toBe("PENDING");
      expect(calls(), "one attempt + one retry").toBe(2);
      expect(rpcStatus, "a recovered submission records no failure").toBeUndefined();
    } finally { h.restore(); }
  });

  it("gives up after a FIXED retry count — never a loop", async () => {
    // MUTATION: loop while status is TRY_AGAIN_LATER — an RPC that never
    // recovers then probes forever inside one settle.
    const { h, calls } = seqStub([{ status: "TRY_AGAIN_LATER" }]);
    try {
      const { value, rpcStatus } = await send();
      expect((value as { status: string }).status).toBe("TRY_AGAIN_LATER");
      expect(calls(), "1 + SUBMIT_RETRY_MAX(2)").toBe(3);
      expect(rpcStatus?.status, "final status still captured for the error body").toBe("TRY_AGAIN_LATER");
    } finally { h.restore(); }
  });

  it("never retries ERROR — a stale payload cannot become fresh", async () => {
    const { h, calls } = seqStub([{ status: "ERROR" }]);
    try {
      await send();
      expect(calls()).toBe(1);
    } finally { h.restore(); }
  });

  it("DUPLICATE on a retry is the falsifier: logged loudly, passed through unchanged", async () => {
    // The safety argument says TRY_AGAIN_LATER = not forwarded. DUPLICATE on
    // the retry contradicts that; the observation must be loud and behaviour
    // must degrade to exactly pre-retry behaviour (fail; nothing spent twice).
    const { h, calls } = seqStub([{ status: "TRY_AGAIN_LATER" }, { status: "DUPLICATE" }]);
    try {
      const { value, rpcStatus } = await send();
      expect((value as { status: string }).status).toBe("DUPLICATE");
      expect(calls(), "stops immediately on DUPLICATE").toBe(2);
      expect(rpcStatus?.status).toBe("DUPLICATE");
      expect(h.logs.some((l) => l.includes("RETRY RETURNED DUPLICATE")), "loud").toBe(true);
    } finally { h.restore(); }
  });
});
