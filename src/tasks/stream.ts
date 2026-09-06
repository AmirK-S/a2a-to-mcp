/**
 * Folding of a SendStreamingMessage stream into one A2A Task snapshot.
 *
 * The stream is a four-armed union discriminated on payload.$case (task,
 * message, statusUpdate, artifactUpdate, recherche/I05 section 8), and payload
 * itself is optional. Only the task and the two update arms carry lifecycle:
 * a message arm on a task stream is a side channel the snapshot ignores.
 *
 * Artifacts arrive in chunks: append says whether the parts extend an artifact
 * already seen or replace it, and lastChunk only marks the end of one artifact,
 * which needs no state of its own since the accumulated parts are already the
 * whole of it.
 */
import {
  TaskState,
  type Artifact,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

/** Builds the seed snapshot of a stream that opened on a status update. */
export function taskFromStatusUpdate(event: TaskStatusUpdateEvent): Task {
  return {
    id: event.taskId,
    contextId: event.contextId,
    status: event.status,
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

/** The A2A state of a snapshot, unspecified when the agent sent none. */
export function stateOf(task: Task): TaskState {
  return task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
}

/**
 * Folds one stream event into a snapshot and returns the new one. An event
 * the snapshot has nothing to do with gives the snapshot back unchanged.
 */
export function applyStreamEvent(snapshot: Task, event: StreamResponse): Task {
  const payload = event.payload;
  if (payload === undefined) {
    return snapshot;
  }
  switch (payload.$case) {
    case "task":
      return payload.value;
    case "statusUpdate":
      return { ...snapshot, status: payload.value.status };
    case "artifactUpdate":
      return { ...snapshot, artifacts: applyArtifact(snapshot.artifacts ?? [], payload.value) };
    default:
      return snapshot;
  }
}

function applyArtifact(
  artifacts: readonly Artifact[],
  event: TaskArtifactUpdateEvent,
): Artifact[] {
  const incoming = event.artifact;
  if (incoming === undefined) {
    return [...artifacts];
  }
  const index = artifacts.findIndex((artifact) => artifact.artifactId === incoming.artifactId);
  if (index === -1) {
    return [...artifacts, incoming];
  }
  const held = artifacts[index] as Artifact;
  const merged: Artifact = event.append
    ? { ...held, parts: [...held.parts, ...incoming.parts] }
    : incoming;
  const next = [...artifacts];
  next[index] = merged;
  return next;
}
