/**
 * Lifecycle mapping: A2A v1.0.1 TaskState (nine values, numeric enum) to the
 * io.modelcontextprotocol/tasks 2026-07-28 TaskStatus (five string values).
 *
 * Each of the nine A2A states has a test here. A state whose mapping loses
 * information must be reported as a loss by the mapper, not silently absorbed.
 */
import { describe, expect, it } from "vitest";
import { TaskState } from "@a2a-js/sdk";

import {
  A2A_TERMINAL_STATES,
  MCP_TASK_STATUSES,
  UnknownTaskStateError,
  fromMcpStatus,
  isTerminalA2AState,
  parseWireTaskState,
  toMcpStatus,
} from "../../src/lifecycle.js";

describe("toMcpStatus: the nine A2A states", () => {
  const exact: Array<[TaskState, string]> = [
    [TaskState.TASK_STATE_WORKING, "working"],
    [TaskState.TASK_STATE_COMPLETED, "completed"],
    [TaskState.TASK_STATE_FAILED, "failed"],
    [TaskState.TASK_STATE_CANCELED, "cancelled"],
  ];

  it.each(exact)("maps %s exactly, without loss", (state, status) => {
    const mapped = toMcpStatus(state);
    expect(mapped.status).toBe(status);
    expect(mapped.lossy).toBe(false);
    expect(mapped.note).toBeUndefined();
  });

  it("spells the cancelled status with two l on the MCP side", () => {
    // A2A: TASK_STATE_CANCELED (one l). MCP: "cancelled" (two l). Copy trap.
    expect(toMcpStatus(TaskState.TASK_STATE_CANCELED).status).toBe("cancelled");
    expect(MCP_TASK_STATUSES).toContain("cancelled");
    expect(MCP_TASK_STATUSES).not.toContain("canceled");
  });

  const lossy: Array<[TaskState, string, RegExp]> = [
    [TaskState.TASK_STATE_SUBMITTED, "working", /submitted/i],
    [TaskState.TASK_STATE_INPUT_REQUIRED, "input_required", /free text|synthesi/i],
    [TaskState.TASK_STATE_REJECTED, "failed", /rejected/i],
    [TaskState.TASK_STATE_AUTH_REQUIRED, "failed", /auth/i],
    [TaskState.TASK_STATE_UNSPECIFIED, "failed", /unspecified/i],
  ];

  it.each(lossy)(
    "maps %s to %s and reports the loss in a note",
    (state, status, notePattern) => {
      const mapped = toMcpStatus(state);
      expect(mapped.status).toBe(status);
      expect(mapped.lossy).toBe(true);
      expect(mapped.note).toBeDefined();
      expect(mapped.note).toMatch(notePattern);
      expect(mapped.note!.length).toBeGreaterThan(20);
    },
  );

  it("never maps AUTH_REQUIRED to input_required (no credential collection through a form)", () => {
    expect(toMcpStatus(TaskState.TASK_STATE_AUTH_REQUIRED).status).not.toBe("input_required");
  });

  it("covers all nine named enum values and nothing else", () => {
    const named = Object.values(TaskState).filter(
      (v): v is TaskState => typeof v === "number" && v >= 0,
    );
    expect(named).toHaveLength(9);
    for (const state of named) {
      expect(MCP_TASK_STATUSES).toContain(toMcpStatus(state).status);
    }
  });

  it("throws on UNRECOGNIZED and on any number outside the enum", () => {
    expect(() => toMcpStatus(TaskState.UNRECOGNIZED)).toThrow(UnknownTaskStateError);
    expect(() => toMcpStatus(99 as TaskState)).toThrow(UnknownTaskStateError);
    expect(() => toMcpStatus(-7 as TaskState)).toThrow(UnknownTaskStateError);
  });

  it("throws on a wire string passed where the enum is expected", () => {
    // ts-proto trap: a string literal is not an enum member at runtime.
    expect(() => toMcpStatus("TASK_STATE_WORKING" as unknown as TaskState)).toThrow(
      UnknownTaskStateError,
    );
  });
});

describe("fromMcpStatus: the five MCP statuses", () => {
  it.each([
    ["working", TaskState.TASK_STATE_WORKING],
    ["completed", TaskState.TASK_STATE_COMPLETED],
    ["failed", TaskState.TASK_STATE_FAILED],
    ["cancelled", TaskState.TASK_STATE_CANCELED],
    ["input_required", TaskState.TASK_STATE_INPUT_REQUIRED],
  ] as const)("maps %s back to %s", (status, state) => {
    expect(fromMcpStatus(status)).toBe(state);
  });

  it("round-trips the four exact states and input_required", () => {
    for (const state of [
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_INPUT_REQUIRED,
    ]) {
      expect(fromMcpStatus(toMcpStatus(state).status)).toBe(state);
    }
  });

  it("does not round-trip the three lossy states, by design", () => {
    expect(fromMcpStatus(toMcpStatus(TaskState.TASK_STATE_SUBMITTED).status)).toBe(
      TaskState.TASK_STATE_WORKING,
    );
    expect(fromMcpStatus(toMcpStatus(TaskState.TASK_STATE_REJECTED).status)).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    expect(fromMcpStatus(toMcpStatus(TaskState.TASK_STATE_AUTH_REQUIRED).status)).toBe(
      TaskState.TASK_STATE_FAILED,
    );
  });

  it("rejects an unknown MCP status string", () => {
    expect(() => fromMcpStatus("canceled" as never)).toThrow();
    expect(() => fromMcpStatus("done" as never)).toThrow();
  });
});

describe("terminal states", () => {
  it("lists exactly COMPLETED, FAILED, CANCELED and REJECTED as terminal (A2A spec 3.1.2)", () => {
    expect(new Set(A2A_TERMINAL_STATES)).toEqual(
      new Set([
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED,
      ]),
    );
  });

  it.each([
    [TaskState.TASK_STATE_SUBMITTED, false],
    [TaskState.TASK_STATE_WORKING, false],
    [TaskState.TASK_STATE_INPUT_REQUIRED, false],
    [TaskState.TASK_STATE_AUTH_REQUIRED, false],
    [TaskState.TASK_STATE_UNSPECIFIED, false],
    [TaskState.TASK_STATE_COMPLETED, true],
    [TaskState.TASK_STATE_FAILED, true],
    [TaskState.TASK_STATE_CANCELED, true],
    [TaskState.TASK_STATE_REJECTED, true],
  ])("isTerminalA2AState(%s) is %s", (state, expected) => {
    expect(isTerminalA2AState(state)).toBe(expected);
  });
});

describe("parseWireTaskState: ProtoJSON strings to the enum", () => {
  it("parses the nine SCREAMING_SNAKE_CASE wire strings", () => {
    expect(parseWireTaskState("TASK_STATE_WORKING")).toBe(TaskState.TASK_STATE_WORKING);
    expect(parseWireTaskState("TASK_STATE_CANCELED")).toBe(TaskState.TASK_STATE_CANCELED);
    expect(parseWireTaskState("TASK_STATE_AUTH_REQUIRED")).toBe(
      TaskState.TASK_STATE_AUTH_REQUIRED,
    );
  });

  it("accepts the numeric form ProtoJSON also allows", () => {
    expect(parseWireTaskState(2)).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("throws on an unknown string instead of returning UNRECOGNIZED", () => {
    expect(() => parseWireTaskState("TASK_STATE_CANCELLED")).toThrow(UnknownTaskStateError);
    expect(() => parseWireTaskState("working")).toThrow(UnknownTaskStateError);
    expect(() => parseWireTaskState("")).toThrow(UnknownTaskStateError);
  });
});
