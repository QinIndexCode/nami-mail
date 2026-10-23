import { MAX_OFFICE_BLOCKS } from "../budget";
import type { Block, Sheet, SurfaceProps } from "../document";

/**
 * Office surface (plan §4.4).
 *
 * Blocks are plain text nodes — the decoder never produced markup, and nothing
 * here parses it. Sheets are a table, sliced to the same 200 × 50 window the
 * plan promises; the slice is the render half of the ceiling, next to the
 * decoder's block/character meter.
 */

const MAX_SHEET_ROWS = 200;
const MAX_SHEET_COLUMNS = 50;

function BlockList({ blocks }: { blocks: readonly Block[] }) {
  if (blocks.length > MAX_OFFICE_BLOCKS) {
    throw new Error(`office surface received ${blocks.length} blocks, over the ${MAX_OFFICE_BLOCKS} ceiling`);
  }
  return (
    <div className="attachment-preview-office">
      {blocks.map((block, index) => (
        <p key={index} className="attachment-preview-office-block">
          {block.text}
        </p>
      ))}
    </div>
  );
}

function SheetTable({ sheet, index }: { sheet: Sheet; index: number }) {
  return (
    <div className="attachment-preview-sheet">
      <p className="attachment-preview-sheet-name">{sheet.name || `#${index + 1}`}</p>
      <div className="attachment-preview-sheet-scroll" tabIndex={0}>
        <table>
          <tbody>
            {sheet.rows.slice(0, MAX_SHEET_ROWS).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.slice(0, MAX_SHEET_COLUMNS).map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function OfficeSurface({ document }: SurfaceProps) {
  const surface = document.surface;
  if (surface.surface === "blocks") return <BlockList blocks={surface.blocks} />;
  if (surface.surface === "sheet") {
    return (
      <div className="attachment-preview-sheets">
        {surface.sheets.map((sheet, index) => (
          <SheetTable key={index} sheet={sheet} index={index} />
        ))}
      </div>
    );
  }
  return null;
}
