/**
 * Parts mapping: A2A v1.0.1 Part (oneof text | raw | url | data, plus filename
 * and mediaType outside the oneof) to MCP 2026-07-28 content blocks and back.
 *
 * Every Part kind and every Artifact field the bridge carries has a test
 * here. Losses (filename, artifact identity) must land in _meta, never vanish.
 */
import { describe, expect, it } from "vitest";
import type { Artifact, Message, Part } from "@a2a-js/sdk";
import { Role } from "@a2a-js/sdk";

import {
  A2A_META_KEY,
  InvalidPartError,
  artifactToContent,
  contentToPart,
  messageToContent,
  partToContent,
  structuredContentFromParts,
} from "../../src/parts.js";

const textPart: Part = {
  content: { $case: "text", value: "hello from A2A" },
  metadata: undefined,
  filename: "",
  mediaType: "",
};

const dataPart: Part = {
  content: { $case: "data", value: { answer: 42, tags: ["a", "b"] } },
  metadata: { source: "unit-test" },
  filename: "",
  mediaType: "",
};

const urlPart: Part = {
  content: { $case: "url", value: "https://example.org/report.pdf" },
  metadata: undefined,
  filename: "report.pdf",
  mediaType: "application/pdf",
};

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const rawImagePart: Part = {
  content: { $case: "raw", value: pngBytes },
  metadata: undefined,
  filename: "pixel.png",
  mediaType: "image/png",
};

const rawAudioPart: Part = {
  content: { $case: "raw", value: Buffer.from("RIFF....WAVE") },
  metadata: undefined,
  filename: "beep.wav",
  mediaType: "audio/wav",
};

const rawBlobPart: Part = {
  content: { $case: "raw", value: Buffer.from("%PDF-1.7") },
  metadata: undefined,
  filename: "invoice.pdf",
  mediaType: "application/pdf",
};

describe("A2A_META_KEY", () => {
  it("is a reverse-DNS prefixed _meta key as MCP requires", () => {
    expect(A2A_META_KEY).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+\/[A-Za-z0-9_.-]+$/);
  });
});

describe("partToContent: the four Part kinds", () => {
  it("text becomes TextContent", () => {
    expect(partToContent(textPart)).toEqual({ type: "text", text: "hello from A2A" });
  });

  it("data becomes TextContent holding the JSON, flagged as data in _meta", () => {
    const block = partToContent(dataPart);
    expect(block.type).toBe("text");
    expect(JSON.parse((block as { text: string }).text)).toEqual({ answer: 42, tags: ["a", "b"] });
    expect(block._meta?.[A2A_META_KEY]).toMatchObject({ partKind: "data" });
  });

  it("url becomes a ResourceLink carrying filename as name and mediaType as mimeType", () => {
    expect(partToContent(urlPart)).toMatchObject({
      type: "resource_link",
      uri: "https://example.org/report.pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    });
  });

  it("url without filename falls back to the URI as name", () => {
    const block = partToContent({ ...urlPart, filename: "" });
    expect(block).toMatchObject({ type: "resource_link", name: "https://example.org/report.pdf" });
  });

  it("raw image/* becomes ImageContent in base64 with the filename kept in _meta", () => {
    const block = partToContent(rawImagePart);
    expect(block).toMatchObject({
      type: "image",
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    });
    expect(block._meta?.[A2A_META_KEY]).toMatchObject({ filename: "pixel.png" });
  });

  it("raw audio/* becomes AudioContent in base64", () => {
    const block = partToContent(rawAudioPart);
    expect(block).toMatchObject({ type: "audio", mimeType: "audio/wav" });
    expect((block as { data: string }).data).toBe(Buffer.from("RIFF....WAVE").toString("base64"));
  });

  it("raw of any other media type becomes an embedded blob resource", () => {
    const block = partToContent(rawBlobPart);
    expect(block.type).toBe("resource");
    const resource = (block as { resource: { uri: string; blob: string; mimeType: string } })
      .resource;
    expect(resource.mimeType).toBe("application/pdf");
    expect(resource.blob).toBe(Buffer.from("%PDF-1.7").toString("base64"));
    expect(resource.uri).toMatch(/^a2a:\/\//);
    expect(resource.uri).toContain("invoice.pdf");
  });

  it("carries Part.metadata into _meta under the bridge key", () => {
    const block = partToContent(dataPart);
    expect(block._meta?.[A2A_META_KEY]).toMatchObject({ metadata: { source: "unit-test" } });
  });

  it("throws InvalidPartError on a Part with no content set", () => {
    expect(() =>
      partToContent({ content: undefined, metadata: undefined, filename: "", mediaType: "" }),
    ).toThrow(InvalidPartError);
  });

  it("throws InvalidPartError on the v0.3 shape with a kind field", () => {
    expect(() => partToContent({ kind: "text", text: "old" } as unknown as Part)).toThrow(
      InvalidPartError,
    );
  });
});

describe("contentToPart: round trips", () => {
  it.each([
    ["text", textPart],
    ["data", dataPart],
    ["url", urlPart],
    ["raw image", rawImagePart],
    ["raw audio", rawAudioPart],
    ["raw blob", rawBlobPart],
  ] as const)("%s survives partToContent then contentToPart", (_label, part) => {
    const back = contentToPart(partToContent(part));
    expect(back.content?.$case).toBe(part.content?.$case);
    if (part.content?.$case === "raw") {
      expect(Buffer.from(back.content!.value as Buffer)).toEqual(part.content.value);
    } else {
      expect(back.content?.value).toEqual(part.content?.value);
    }
    expect(back.filename).toBe(part.filename);
    expect(back.mediaType).toBe(part.mediaType);
    expect(back.metadata ?? undefined).toEqual(part.metadata ?? undefined);
  });

  it("turns a plain MCP TextContent from a client into a text Part", () => {
    expect(contentToPart({ type: "text", text: "from the model" })).toEqual({
      content: { $case: "text", value: "from the model" },
      metadata: undefined,
      filename: "",
      mediaType: "",
    });
  });

  it("rejects an unknown content block type", () => {
    expect(() => contentToPart({ type: "video" } as never)).toThrow(InvalidPartError);
  });
});

describe("artifactToContent: identity preserved in _meta", () => {
  const artifact: Artifact = {
    artifactId: "art-1",
    name: "summary",
    description: "The summary",
    parts: [textPart, dataPart],
    metadata: undefined,
    extensions: [],
  };

  it("emits one block per part, each tagged with artifactId and name", () => {
    const blocks = artifactToContent(artifact);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block._meta?.[A2A_META_KEY]).toMatchObject({
        artifactId: "art-1",
        artifactName: "summary",
      });
    }
  });

  it("keeps the part order", () => {
    const blocks = artifactToContent(artifact);
    expect(blocks[0]?.type).toBe("text");
    expect((blocks[0] as { text: string }).text).toBe("hello from A2A");
  });
});

describe("messageToContent", () => {
  const message: Message = {
    messageId: "m-1",
    contextId: "ctx-1",
    taskId: "",
    role: Role.ROLE_AGENT,
    parts: [textPart, urlPart],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };

  it("maps every part and tags blocks with the messageId", () => {
    const blocks = messageToContent(message);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.type).toBe("resource_link");
    expect(blocks[0]?._meta?.[A2A_META_KEY]).toMatchObject({ messageId: "m-1" });
  });
});

describe("structuredContentFromParts", () => {
  it("returns the single data part value as structuredContent", () => {
    expect(structuredContentFromParts([textPart, dataPart])).toEqual({
      answer: 42,
      tags: ["a", "b"],
    });
  });

  it("returns undefined when there is no data part", () => {
    expect(structuredContentFromParts([textPart, urlPart])).toBeUndefined();
  });

  it("returns undefined when there are several data parts, so nothing is silently dropped", () => {
    expect(structuredContentFromParts([dataPart, dataPart])).toBeUndefined();
  });

  it("wraps a non-object data value so structuredContent stays an object", () => {
    const scalar: Part = { ...dataPart, content: { $case: "data", value: 7 } };
    expect(structuredContentFromParts([scalar])).toEqual({ value: 7 });
  });
});
