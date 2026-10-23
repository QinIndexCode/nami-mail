// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ResourceScope } from "../document";
import { documentWith, markup, zh } from "../testing/surfaceHarness";
import ArchiveSurface from "./ArchiveSurface";

const scope = new ResourceScope();
const onDownload = () => undefined;

describe("ArchiveSurface", () => {
  it("lists entries without offering to open or extract them", () => {
    const html = markup(
      <ArchiveSurface
        document={documentWith({
          surface: "archive",
          declaredBytes: 3 * 1024,
          entries: [
            { path: "docs/readme.txt", bytes: 1024 },
            { path: "images/logo.png", bytes: 2048 },
          ],
        })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain("docs/readme.txt");
    expect(html).toContain("1.0 KB");
    expect(html).toContain(zh("mail.attachment.previewArchiveCount", { count: 2, size: "3.0 KB" }));
    expect(html).toContain(zh("mail.attachment.previewArchiveNoExtract"));
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("drops paths that try to escape the archive root", () => {
    const html = markup(
      <ArchiveSurface
        document={documentWith({
          surface: "archive",
          declaredBytes: 10,
          entries: [
            { path: "../escape.txt", bytes: 5 },
            { path: "folder/../../escape.txt", bytes: 5 },
            { path: "..hidden/file.txt", bytes: 5 },
            { path: "safe/file.txt", bytes: 5 },
          ],
        })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).not.toContain("../escape.txt");
    expect(html).not.toContain("folder/../");
    expect(html).toContain("..hidden/file.txt");
    expect(html).toContain("safe/file.txt");
  });
});
