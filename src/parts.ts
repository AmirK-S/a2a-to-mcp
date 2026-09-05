/**
 * Mapping between A2A v1.0.1 parts and MCP 2026-07-28 content blocks.
 *
 * An A2A Part is a ts-proto oneof: the discriminant is content.$case, never a
 * kind field, and filename and mediaType sit outside the oneof. Anything MCP
 * has no room for (the filename, the artifact identity, the message identity,
 * the A2A part metadata) is parked under a single reverse DNS _meta key so the
 * reverse mapping can put it back.
 */
import { createHash } from "node:crypto";
import type { Artifact, Message, Part } from "@a2a-js/sdk";
import type {
  AudioContent,
  ContentBlock,
  EmbeddedResource,
  ImageContent,
  ResourceLink,
  TextContent,
} from "@modelcontextprotocol/server";

/** The _meta key under which the bridge parks everything MCP cannot hold. */
export const A2A_META_KEY = "io.github.amirk-s/a2a";

/** Raised when a part or a content block cannot be mapped. */
export class InvalidPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPartError";
  }
}

/** The A2A oneof cases, as ts-proto names them. */
export type A2APartKind = "text" | "raw" | "url" | "data";

/** What the bridge parks under A2A_META_KEY on every block it emits. */
export interface A2APartMeta {
  partKind: A2APartKind;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  artifactId?: string;
  artifactName?: string;
  artifactDescription?: string;
  messageId?: string;
  contextId?: string;
  taskId?: string;
}

/** Identity of the artifact or message a part was carried in. */
export type A2APartOrigin = Omit<A2APartMeta, "partKind" | "filename" | "mediaType" | "metadata">;

const DEFAULT_BLOB_MEDIA_TYPE = "application/octet-stream";
const BLOB_URI_SCHEME = "a2a://part/";

/** Maps one A2A part onto the MCP content block that carries it best. */
export function partToContent(part: Part, origin: A2APartOrigin = {}): ContentBlock {
  assertModernPart(part);
  const content = part.content;
  if (content === undefined) {
    throw new InvalidPartError("A2A Part has no content set: the oneof is empty.");
  }

  switch (content.$case) {
    case "text":
      return withMeta<TextContent>({ type: "text", text: content.value }, part, origin);
    case "data":
      return withMeta<TextContent>(
        { type: "text", text: JSON.stringify(content.value) },
        part,
        origin,
      );
    case "url":
      return withMeta<ResourceLink>(
        {
          type: "resource_link",
          uri: content.value,
          name: part.filename !== "" ? part.filename : content.value,
          ...(part.mediaType !== "" ? { mimeType: part.mediaType } : {}),
        },
        part,
        origin,
      );
    case "raw":
      return rawToContent(part, content.value, origin);
    default:
      throw new InvalidPartError(
        `A2A Part has an unsupported oneof case: ${String((content as { $case: string }).$case)}.`,
      );
  }
}

/** Maps an MCP content block back onto an A2A part. */
export function contentToPart(block: ContentBlock): Part {
  const meta = readMeta(block);
  const metadata = meta?.metadata;

  switch (block.type) {
    case "text": {
      const isData = meta?.partKind === "data";
      return buildPart(
        isData
          ? { $case: "data", value: parseData(block.text) }
          : { $case: "text", value: block.text },
        meta,
        metadata,
        "",
      );
    }
    case "image":
    case "audio":
      return buildPart(
        { $case: "raw", value: Buffer.from(block.data, "base64") },
        meta,
        metadata,
        block.mimeType,
      );
    case "resource_link":
      return buildPart(
        { $case: "url", value: block.uri },
        meta,
        metadata,
        block.mimeType ?? "",
        block.name !== block.uri ? block.name : "",
      );
    case "resource": {
      const resource = block.resource;
      if ("blob" in resource) {
        return buildPart(
          { $case: "raw", value: Buffer.from(resource.blob, "base64") },
          meta,
          metadata,
          resource.mimeType ?? "",
        );
      }
      return buildPart(
        { $case: "text", value: resource.text },
        meta,
        metadata,
        resource.mimeType ?? "",
      );
    }
    default:
      throw new InvalidPartError(
        `Unknown MCP content block type: ${String((block as { type: unknown }).type)}.`,
      );
  }
}

/** Maps every part of an artifact, keeping order and artifact identity. */
export function artifactToContent(artifact: Artifact): ContentBlock[] {
  const origin: A2APartOrigin = {
    ...(artifact.artifactId !== "" ? { artifactId: artifact.artifactId } : {}),
    ...(artifact.name !== "" ? { artifactName: artifact.name } : {}),
    ...(artifact.description !== "" ? { artifactDescription: artifact.description } : {}),
  };
  return artifact.parts.map((part) => partToContent(part, origin));
}

/** Maps every part of a message, keeping order and message identity. */
export function messageToContent(message: Message): ContentBlock[] {
  const origin: A2APartOrigin = {
    ...(message.messageId !== "" ? { messageId: message.messageId } : {}),
    ...(message.contextId !== "" ? { contextId: message.contextId } : {}),
    ...(message.taskId !== "" ? { taskId: message.taskId } : {}),
  };
  return message.parts.map((part) => partToContent(part, origin));
}

/**
 * The structuredContent of a tool result, taken from the parts.
 *
 * Exactly one data part gives structured content; zero gives none, and several
 * give none either, so that nothing is silently dropped.
 */
export function structuredContentFromParts(parts: readonly Part[]): Record<string, unknown> | undefined {
  const dataParts = parts.filter((part) => part.content?.$case === "data");
  const only = dataParts.length === 1 ? dataParts[0] : undefined;
  if (only === undefined || only.content?.$case !== "data") {
    return undefined;
  }
  const value: unknown = only.content.value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function rawToContent(part: Part, bytes: Buffer, origin: A2APartOrigin): ContentBlock {
  const data = Buffer.from(bytes).toString("base64");
  if (part.mediaType.startsWith("image/")) {
    return withMeta<ImageContent>({ type: "image", data, mimeType: part.mediaType }, part, origin);
  }
  if (part.mediaType.startsWith("audio/")) {
    return withMeta<AudioContent>({ type: "audio", data, mimeType: part.mediaType }, part, origin);
  }
  return withMeta<EmbeddedResource>(
    {
      type: "resource",
      resource: {
        uri: blobUri(part, bytes),
        blob: data,
        mimeType: part.mediaType !== "" ? part.mediaType : DEFAULT_BLOB_MEDIA_TYPE,
      },
    },
    part,
    origin,
  );
}

/** A stable, opaque URI for a blob that MCP has no natural address for. */
function blobUri(part: Part, bytes: Buffer): string {
  if (part.filename !== "") {
    return BLOB_URI_SCHEME + encodeURIComponent(part.filename);
  }
  const digest = createHash("sha256").update(bytes).digest("base64url").slice(0, 16);
  return BLOB_URI_SCHEME + digest;
}

function withMeta<B extends ContentBlock>(block: B, part: Part, origin: A2APartOrigin): B {
  const meta = buildMeta(part, origin);
  if (meta === undefined) {
    return block;
  }
  return { ...block, _meta: { [A2A_META_KEY]: meta } };
}

function buildMeta(part: Part, origin: A2APartOrigin): A2APartMeta | undefined {
  const kind = part.content?.$case;
  if (kind === undefined) {
    return undefined;
  }
  const carriesSomething =
    kind === "data" ||
    part.filename !== "" ||
    part.mediaType !== "" ||
    part.metadata !== undefined ||
    Object.keys(origin).length > 0;
  if (!carriesSomething) {
    return undefined;
  }
  return {
    partKind: kind,
    ...(part.filename !== "" ? { filename: part.filename } : {}),
    ...(part.mediaType !== "" ? { mediaType: part.mediaType } : {}),
    ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
    ...origin,
  };
}

function readMeta(block: ContentBlock): A2APartMeta | undefined {
  const container = (block as { _meta?: Record<string, unknown> })._meta;
  const meta = container?.[A2A_META_KEY];
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  return meta as A2APartMeta;
}

function buildPart(
  content: NonNullable<Part["content"]>,
  meta: A2APartMeta | undefined,
  metadata: Record<string, unknown> | undefined,
  fallbackMediaType: string,
  fallbackFilename = "",
): Part {
  return {
    content,
    metadata,
    filename: meta?.filename ?? fallbackFilename,
    mediaType: meta?.mediaType ?? fallbackMediaType,
  };
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new InvalidPartError(
      `Content block is flagged as an A2A data part but does not hold JSON: ${String(error)}`,
    );
  }
}

function assertModernPart(part: Part): void {
  if ("kind" in part) {
    throw new InvalidPartError(
      "A2A Part uses the v0.3 shape with a kind field. " +
        "v1.0.1 discriminates the oneof with content.$case.",
    );
  }
}
