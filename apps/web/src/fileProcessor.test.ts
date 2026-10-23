import { describe, expect, it } from "vitest";
import { classifyAttachmentKind, extensionKinds, mediaKind } from "@nami/agent-contracts";
import {
  attachmentIcon,
  audioExtensions,
  buildAcceptFilter,
  fileToDataUrl,
  formatMessageAttachments,
  imageExtensions,
  isSupportedFile,
  processFile,
  videoExtensions,
} from "./fileProcessor";
import { FileAudio, FileImage, FileText, FileVideo } from "lucide-react";

describe("fileProcessor multimodal support", () => {
  describe("buildAcceptFilter", () => {
    it("defaults to text and document formats when modalities are absent or all false", () => {
      const filterEmpty = buildAcceptFilter();
      expect(filterEmpty).toContain(".txt");
      expect(filterEmpty).toContain(".md");
      expect(filterEmpty).toContain(".docx");
      expect(filterEmpty).toContain(".pptx");
      expect(filterEmpty).not.toContain("image/*");
      expect(filterEmpty).not.toContain("video/*");
      expect(filterEmpty).not.toContain("audio/*");
      expect(filterEmpty).not.toContain(".pdf");

      const filterAllFalse = buildAcceptFilter({ image: false, video: false, audio: false, pdf: false });
      expect(filterAllFalse).not.toContain("image/*");
      expect(filterAllFalse).not.toContain(".pdf");
    });

    it("includes image extensions when image modality is enabled", () => {
      const filter = buildAcceptFilter({ image: true, video: false, audio: false, pdf: false });
      expect(filter).toContain(".png");
      expect(filter).toContain(".jpg");
      expect(filter).toContain("image/*");
      expect(filter).not.toContain("video/*");
      expect(filter).not.toContain(".pdf");
    });

    it("includes video extensions when video modality is enabled", () => {
      const filter = buildAcceptFilter({ image: false, video: true, audio: false, pdf: false });
      expect(filter).toContain(".mp4");
      expect(filter).toContain(".webm");
      expect(filter).toContain("video/*");
      expect(filter).not.toContain("image/*");
    });

    it("includes audio extensions when audio modality is enabled", () => {
      const filter = buildAcceptFilter({ image: false, video: false, audio: true, pdf: false });
      expect(filter).toContain(".mp3");
      expect(filter).toContain(".wav");
      expect(filter).toContain("audio/*");
    });

    it("includes pdf extensions when pdf modality is enabled", () => {
      const filter = buildAcceptFilter({ image: false, video: false, audio: false, pdf: true });
      expect(filter).toContain(".pdf");
      expect(filter).toContain("application/pdf");
    });

    it("includes all modalities when all are enabled", () => {
      const filter = buildAcceptFilter({ image: true, video: true, audio: true, pdf: true });
      expect(filter).toContain("image/*");
      expect(filter).toContain("video/*");
      expect(filter).toContain("audio/*");
      expect(filter).toContain(".pdf");
    });
  });

  describe("isSupportedFile", () => {
    it("always supports text and office files", () => {
      const txt = new File(["hello"], "notes.txt", { type: "text/plain" });
      const md = new File(["# title"], "readme.md", { type: "text/markdown" });
      const docx = new File([""], "proposal.docx");
      const pptx = new File([""], "slides.pptx");

      expect(isSupportedFile(txt)).toBe(true);
      expect(isSupportedFile(md)).toBe(true);
      expect(isSupportedFile(docx)).toBe(true);
      expect(isSupportedFile(pptx)).toBe(true);
    });

    it("rejects image/video/audio/pdf when model is text-only", () => {
      const textOnly = { image: false, video: false, audio: false, pdf: false };
      const img = new File([""], "photo.png", { type: "image/png" });
      const video = new File([""], "clip.mp4", { type: "video/mp4" });
      const audio = new File([""], "speech.mp3", { type: "audio/mp3" });
      const pdf = new File([""], "document.pdf", { type: "application/pdf" });

      expect(isSupportedFile(img, textOnly)).toBe(false);
      expect(isSupportedFile(video, textOnly)).toBe(false);
      expect(isSupportedFile(audio, textOnly)).toBe(false);
      expect(isSupportedFile(pdf, textOnly)).toBe(false);
    });

    it("supports enabled modalities specifically", () => {
      const img = new File([""], "photo.jpg");
      const video = new File([""], "demo.webm");
      const audio = new File([""], "recording.wav");
      const pdf = new File([""], "paper.pdf");

      expect(isSupportedFile(img, { image: true, video: false, audio: false, pdf: false })).toBe(true);
      expect(isSupportedFile(video, { image: false, video: true, audio: false, pdf: false })).toBe(true);
      expect(isSupportedFile(audio, { image: false, video: false, audio: true, pdf: false })).toBe(true);
      expect(isSupportedFile(pdf, { image: false, video: false, audio: false, pdf: true })).toBe(true);
    });
  });

  describe("capability gates vs the classification table", () => {
    it("keeps image/video/audio gates a subset of the contract kinds", () => {
      for (const extension of imageExtensions) {
        expect(classifyAttachmentKind(`file.${extension}`, ""), extension).toBe("image");
      }
      for (const extension of videoExtensions) {
        expect(classifyAttachmentKind(`file.${extension}`, ""), extension).toBe("media");
        expect(mediaKind(`file.${extension}`), extension).toBe("video");
      }
      for (const extension of audioExtensions) {
        expect(classifyAttachmentKind(`file.${extension}`, ""), extension).toBe("media");
        expect(mediaKind(`file.${extension}`), extension).toBe("audio");
      }
    });

    it("stays narrower than the catalog so models never receive undecodable formats", () => {
      // The catalog classifies these as images, but no model wired up here can
      // decode them. Merging the two lists would silently widen what gets
      // base64-uploaded to a model that cannot read it.
      for (const extension of ["avif", "heic", "heif", "ico", "tif", "tiff"]) {
        expect(extensionKinds[extension], extension).toBe("image");
        expect(imageExtensions.has(extension), extension).toBe(false);
      }
      const catalogImages = Object.keys(extensionKinds).filter((extension) => extensionKinds[extension] === "image");
      const catalogMedia = Object.keys(extensionKinds).filter((extension) => extensionKinds[extension] === "media");
      expect(catalogImages.length).toBeGreaterThan(imageExtensions.size);
      expect(catalogMedia.length).toBeGreaterThan(videoExtensions.size + audioExtensions.size);
    });

    it("reads .mdx as text now that it is a readable text extension", async () => {
      const file = new File(["# heading"], "notes.mdx", { type: "text/markdown" });
      expect(isSupportedFile(file)).toBe(true);
      const processed = await processFile(file);
      expect(processed.text).toBe("# heading");
      expect(processed.type).toBe("mdx");
    });

    it("keeps the previously readable formats readable", () => {
      for (const extension of ["txt", "md", "markdown", "csv", "tsv", "log", "rtf", "ini", "cfg", "conf"]) {
        expect(isSupportedFile(new File(["x"], `file.${extension}`, { type: "text/plain" })), extension).toBe(true);
      }
    });
  });

  describe("attachmentIcon", () => {
    it("returns appropriate icon for each modality", () => {
      expect(attachmentIcon("png")).toBe(FileImage);
      expect(attachmentIcon("jpg")).toBe(FileImage);
      expect(attachmentIcon("mp4")).toBe(FileVideo);
      expect(attachmentIcon("webm")).toBe(FileVideo);
      expect(attachmentIcon("mp3")).toBe(FileAudio);
      expect(attachmentIcon("wav")).toBe(FileAudio);
      expect(attachmentIcon("pdf")).toBe(FileText);
      expect(attachmentIcon("txt")).toBe(FileText);
    });
  });

  describe("processFile", () => {
    it("processes text files correctly", async () => {
      const file = new File(["hello world"], "test.txt", { type: "text/plain" });
      const processed = await processFile(file);
      expect(processed.name).toBe("test.txt");
      expect(processed.text).toBe("hello world");
      expect(processed.type).toBe("txt");
    });

    it("processes image files with descriptor text", async () => {
      const file = new File([new Uint8Array(2048)], "diagram.png", { type: "image/png" });
      const processed = await processFile(file);
      expect(processed.name).toBe("diagram.png");
      expect(processed.text).toContain("[Image: diagram.png");
      expect(processed.type).toBe("png");
    });

    it("processes video files with descriptor text", async () => {
      const file = new File([new Uint8Array(1024 * 1024 * 2)], "screen.mp4", { type: "video/mp4" });
      const processed = await processFile(file);
      expect(processed.name).toBe("screen.mp4");
      expect(processed.text).toContain("[Video: screen.mp4");
      expect(processed.type).toBe("mp4");
    });

    it("processes audio files with descriptor text", async () => {
      const file = new File([new Uint8Array(4096)], "voice.mp3", { type: "audio/mp3" });
      const processed = await processFile(file);
      expect(processed.name).toBe("voice.mp3");
      expect(processed.text).toContain("[Audio: voice.mp3");
      expect(processed.type).toBe("mp3");
    });

    it("extracts dataUrl and mimeType for multimodal files", async () => {
      const file = new File(["fake image content"], "photo.png", { type: "image/png" });
      const processed = await processFile(file);
      expect(processed.mimeType).toBe("image/png");
      expect(processed.dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it("converts files directly to dataUrl via fileToDataUrl", async () => {
      const file = new File(["audio binary data"], "clip.mp3", { type: "audio/mpeg" });
      const dataUrl = await fileToDataUrl(file);
      expect(dataUrl).toMatch(/^data:audio\/mpeg;base64,/);
    });
  });

  describe("formatMessageAttachments", () => {
    it("formats processed files preserving multimodal and mail metadata", () => {
      const formatted = formatMessageAttachments([
        {
          name: "chart.png",
          size: 1024,
          type: "png",
          text: "[Image: chart.png (1 KB)]",
          truncated: false,
          path: "/tmp/chart.png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo...",
          mimeType: "image/png",
          mailToken: "out_12345678-1234-1234-1234-123456789abc",
          mailAccountId: "acc_1",
        },
        {
          name: "notes.txt",
          size: 256,
          type: "txt",
          text: "hello world",
          truncated: false,
        },
      ]);

      expect(formatted).toEqual([
        {
          name: "chart.png",
          type: "png",
          path: "/tmp/chart.png",
          token: "out_12345678-1234-1234-1234-123456789abc",
          accountId: "acc_1",
          text: "[Image: chart.png (1 KB)]",
          dataUrl: "data:image/png;base64,iVBORw0KGgo...",
          mimeType: "image/png",
        },
        {
          name: "notes.txt",
          type: "txt",
          text: "hello world",
        },
      ]);
    });
  });
});
