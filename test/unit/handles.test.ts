/**
 * Handle table: the bridge mints opaque handles for A2A task and context ids,
 * hands them to the MCP client as ordinary strings, and resolves them on the
 * next call. MCP 2026-07-28, server/tools "Stateful Tools": opaque, bounded
 * lifetime, explicit error on expiry.
 */
import { describe, expect, it } from "vitest";

import { BridgeHandles } from "../../src/envelope.js";
import {
  HandleExpiredError,
  HandleTable,
  UnknownHandleError,
} from "../../src/handles.js";

interface TaskRef {
  alias: string;
  a2aTaskId: string;
  contextId: string;
}

const ref: TaskRef = { alias: "hello", a2aTaskId: "task-123", contextId: "ctx-456" };

function tableAt(startMs: number, ttlMs = 60_000) {
  let now = startMs;
  const table = new HandleTable<TaskRef>({ ttlMs, now: () => now, prefix: "tk" });
  return { table, advance: (ms: number) => (now += ms) };
}

describe("minting", () => {
  it("returns a non-empty string that is not the A2A id and does not contain it", () => {
    const { table } = tableAt(0);
    const handle = table.mint(ref);
    expect(typeof handle).toBe("string");
    expect(handle.length).toBeGreaterThan(8);
    expect(handle).not.toBe(ref.a2aTaskId);
    expect(handle).not.toContain(ref.a2aTaskId);
    expect(handle).not.toContain(ref.contextId);
    expect(handle).not.toContain(ref.alias);
  });

  it("uses the configured prefix so handles are recognisable in a transcript", () => {
    const { table } = tableAt(0);
    expect(table.mint(ref).startsWith("tk_")).toBe(true);
  });

  it("mints distinct handles for distinct calls, even for the same value", () => {
    const { table } = tableAt(0);
    const a = table.mint(ref);
    const b = table.mint({ ...ref });
    expect(a).not.toBe(b);
  });

  it("returns the same handle for the same key when mintFor is used with a key", () => {
    const { table } = tableAt(0);
    const a = table.mintFor("hello:task-123", ref);
    const b = table.mintFor("hello:task-123", ref);
    expect(a).toBe(b);
    expect(table.size).toBe(1);
  });

  it("only produces characters valid in a JSON string and safe in a URL", () => {
    const { table } = tableAt(0);
    for (let i = 0; i < 50; i += 1) {
      expect(table.mint(ref)).toMatch(/^tk_[A-Za-z0-9_-]+$/);
    }
  });
});

describe("resolving", () => {
  it("resolves a fresh handle to the value it was minted for", () => {
    const { table } = tableAt(0);
    const handle = table.mint(ref);
    expect(table.resolve(handle)).toEqual(ref);
  });

  it("throws UnknownHandleError for a handle it never minted", () => {
    const { table } = tableAt(0);
    expect(() => table.resolve("tk_nope")).toThrow(UnknownHandleError);
    expect(() => table.resolve("")).toThrow(UnknownHandleError);
    expect(() => table.resolve(ref.a2aTaskId)).toThrow(UnknownHandleError);
  });

  it("throws HandleExpiredError, distinct from unknown, once the ttl has elapsed", () => {
    const { table, advance } = tableAt(1_000, 60_000);
    const handle = table.mint(ref);
    advance(59_999);
    expect(table.resolve(handle)).toEqual(ref);
    advance(2);
    expect(() => table.resolve(handle)).toThrow(HandleExpiredError);
    expect(() => table.resolve(handle)).not.toThrow(UnknownHandleError);
  });

  it("carries the handle and the expiry in the error message", () => {
    const { table, advance } = tableAt(0, 1_000);
    const handle = table.mint(ref);
    advance(5_000);
    let caught: unknown;
    try {
      table.resolve(handle);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HandleExpiredError);
    expect((caught as Error).message).toContain(handle);
    expect((caught as Error).message).toMatch(/expired/i);
  });

  it("touch extends the lifetime from now, not from the original mint", () => {
    const { table, advance } = tableAt(0, 1_000);
    const handle = table.mint(ref);
    advance(900);
    table.touch(handle);
    advance(900);
    expect(table.resolve(handle)).toEqual(ref);
    advance(200);
    expect(() => table.resolve(handle)).toThrow(HandleExpiredError);
  });

  it("peek reports the remaining lifetime in milliseconds without touching", () => {
    const { table, advance } = tableAt(0, 1_000);
    const handle = table.mint(ref);
    advance(400);
    expect(table.remainingMs(handle)).toBe(600);
    advance(600);
    expect(table.remainingMs(handle)).toBe(0);
  });
});

describe("housekeeping", () => {
  it("sweep removes expired entries and reports how many", () => {
    const { table, advance } = tableAt(0, 1_000);
    table.mint(ref);
    table.mint(ref);
    advance(500);
    const late = table.mint(ref);
    advance(700);
    expect(table.sweep()).toBe(2);
    expect(table.size).toBe(1);
    expect(table.resolve(late)).toEqual(ref);
  });

  it("delete removes a handle explicitly and resolving it afterwards is unknown", () => {
    const { table } = tableAt(0);
    const handle = table.mint(ref);
    expect(table.delete(handle)).toBe(true);
    expect(table.delete(handle)).toBe(false);
    expect(() => table.resolve(handle)).toThrow(UnknownHandleError);
  });

  it("refuses a non-positive ttl at construction", () => {
    expect(() => new HandleTable<TaskRef>({ ttlMs: 0 })).toThrow();
    expect(() => new HandleTable<TaskRef>({ ttlMs: -1 })).toThrow();
  });

  it("describes its retention policy in one sentence for tool descriptions", () => {
    const { table } = tableAt(0, 15 * 60_000);
    const text = table.describeRetention();
    expect(text).toMatch(/15 minutes/);
    expect(text).toMatch(/memory/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("minting again for a key already held", () => {
  it("mintFor restarts the lifetime of a live handle, exactly as touch does", () => {
    const { table, advance } = tableAt(0, 1_000);
    const first = table.mintFor("hello:ctx-456", ref);
    advance(900);
    const second = table.mintFor("hello:ctx-456", ref);
    expect(second).toBe(first);
    advance(900);
    expect(table.resolve(first)).toEqual(ref);
    advance(200);
    expect(() => table.resolve(first)).toThrow(HandleExpiredError);
  });

  it("mints a fresh handle once the key has expired, rather than reviving the old one", () => {
    const { table, advance } = tableAt(0, 1_000);
    const first = table.mintFor("hello:ctx-456", ref);
    advance(1_500);
    const second = table.mintFor("hello:ctx-456", ref);
    expect(second).not.toBe(first);
    expect(table.resolve(second)).toEqual(ref);
    expect(() => table.resolve(first)).toThrow(UnknownHandleError);
  });

  it("keeps a context handle alive well past one ttl, which is what the tools promise", () => {
    // The retention sentence the three tool descriptions carry says fifteen
    // minutes after the last use. A context handle is never touched by name:
    // it is minted again, under the same key, by every reply that carries it,
    // so this is the path that has to restart the clock.
    let now = 0;
    const ttlMs = 15 * 60_000;
    const handles = new BridgeHandles({ ttlMs, now: () => now });
    const record = { alias: "hello", contextId: "ctx-456" };
    const handle = handles.mintContext("hello", "ctx-456");
    for (let turn = 0; turn < 4; turn += 1) {
      now += 14 * 60_000;
      expect(handles.resolveContext(handle)).toEqual(record);
      expect(handles.mintContext("hello", "ctx-456")).toBe(handle);
    }
    expect(now).toBeGreaterThan(ttlMs);
    now += ttlMs + 1;
    expect(() => handles.resolveContext(handle)).toThrow(HandleExpiredError);
  });
});
