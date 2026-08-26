import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodoAttachment } from "../../../../shared/types.ts";
import { TodoAttachments } from "../TodoAttachments.tsx";

function makeAttachment(id: number, extra: Partial<TodoAttachment> = {}): TodoAttachment {
  return {
    id,
    todoId: 7,
    sha256: "a".repeat(64),
    fileName: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    kind: "image",
    url: "app-media://attachments/" + "a".repeat(64) + ".png",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

const image = makeAttachment(1);
const pdfFile = makeAttachment(2, {
  sha256: "b".repeat(64),
  fileName: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3 * 1024 * 1024,
  kind: "file",
  url: "app-media://attachments/" + "b".repeat(64) + ".pdf",
});

const mockAttachmentAPI = {
  add: vi.fn(),
  addBuffer: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", { attachment: mockAttachmentAPI });
  mockAttachmentAPI.list.mockResolvedValue([image, pdfFile]);
  mockAttachmentAPI.add.mockResolvedValue(makeAttachment(3, { fileName: "added.png" }));
  mockAttachmentAPI.delete.mockResolvedValue(undefined);
  mockAttachmentAPI.open.mockResolvedValue(null);
});

afterEach(() => {
  // The suite runs without `globals: true`, so RTL's auto-cleanup never registers.
  cleanup();
  vi.clearAllMocks();
});

describe("TodoAttachments rendering", () => {
  it("lists an image as a thumbnail and a document as an extension glyph, with sizes", async () => {
    render(<TodoAttachments todoId={7} />);

    const thumb = await screen.findByAltText("screenshot.png");
    expect(thumb).toHaveAttribute("src", image.url);
    expect(screen.getByText("2 KB")).toBeInTheDocument();

    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("3.0 MB")).toBeInTheDocument();

    expect(screen.getByText("Attachments (2)")).toBeInTheDocument();
    expect(mockAttachmentAPI.list).toHaveBeenCalledWith(7);
  });

  it("reports a failed read in words the user can act on, not the internal message", async () => {
    mockAttachmentAPI.list.mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    render(<TodoAttachments todoId={7} />);

    expect(await screen.findByText("Could not load the attachments for this todo.")).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
  });

  it("says so when the todo has no attachments", async () => {
    mockAttachmentAPI.list.mockResolvedValue([]);
    render(<TodoAttachments todoId={7} />);

    expect(await screen.findByText(/No attachments yet/)).toBeInTheDocument();
    expect(screen.getByText("Attachments")).toBeInTheDocument();
  });
});

describe("TodoAttachments actions", () => {
  it("removes an attachment through IPC and reloads the strip", async () => {
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    mockAttachmentAPI.list.mockResolvedValue([pdfFile]);
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }));

    await waitFor(() => expect(mockAttachmentAPI.delete).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByAltText("screenshot.png")).not.toBeInTheDocument());
    expect(mockAttachmentAPI.list).toHaveBeenCalledTimes(2);
  });

  it("attaches through the OS picker and reloads", async () => {
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));

    await waitFor(() => expect(mockAttachmentAPI.add).toHaveBeenCalledWith({ todoId: 7 }));
    await waitFor(() => expect(mockAttachmentAPI.list).toHaveBeenCalledTimes(2));
  });

  it("does not reload when the user cancels the picker", async () => {
    mockAttachmentAPI.add.mockResolvedValue(null);
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));

    await waitFor(() => expect(mockAttachmentAPI.add).toHaveBeenCalled());
    // The button re-enables only once the whole add cycle is over, reload included. Asserting
    // straight after `add` resolves would race a reload that had been queued but not run.
    await waitFor(() => expect(screen.getByRole("button", { name: "Attach file" })).not.toBeDisabled());
    expect(mockAttachmentAPI.list).toHaveBeenCalledTimes(1);
  });

  it("opens a document with the OS default application", async () => {
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    fireEvent.click(screen.getByRole("button", { name: "Open spec.pdf" }));

    await waitFor(() => expect(mockAttachmentAPI.open).toHaveBeenCalledWith(2));
  });

  it("surfaces the OS error text when opening fails", async () => {
    mockAttachmentAPI.open.mockResolvedValue("No application is registered for .pdf");
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    fireEvent.click(screen.getByRole("button", { name: "Open spec.pdf" }));

    expect(await screen.findByText("No application is registered for .pdf")).toBeInTheDocument();
  });

  it("hands an image embed to onInsertEmbed and offers no insert for documents", async () => {
    const onInsertEmbed = vi.fn();
    render(<TodoAttachments todoId={7} onInsertEmbed={onInsertEmbed} />);
    await screen.findByAltText("screenshot.png");

    expect(screen.queryByRole("button", { name: "Insert spec.pdf into notes" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Insert screenshot.png into notes" }));

    expect(onInsertEmbed).toHaveBeenCalledWith("![screenshot.png](" + image.url + ")");
  });

  it("hides the insert control when no notes editor is wired up", async () => {
    render(<TodoAttachments todoId={7} />);
    await screen.findByAltText("screenshot.png");

    expect(screen.queryByRole("button", { name: "Insert screenshot.png into notes" })).not.toBeInTheDocument();
  });
});

describe("TodoAttachments create mode", () => {
  it("disables the strip and explains why, without touching IPC", () => {
    render(<TodoAttachments todoId={null} />);

    expect(screen.getByText("Create this todo first, then attach files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeDisabled();
    expect(mockAttachmentAPI.list).not.toHaveBeenCalled();
  });
});

describe("TodoAttachments missing blob", () => {
  it("swaps a thumbnail that fails to load for a broken-attachment placeholder", async () => {
    render(<TodoAttachments todoId={7} />);
    const thumb = await screen.findByAltText("screenshot.png");

    fireEvent.error(thumb);

    expect(await screen.findByText("Missing file")).toBeInTheDocument();
    expect(screen.queryByAltText("screenshot.png")).not.toBeInTheDocument();
    // The row is still there, so the user can still remove the dangling attachment.
    expect(screen.getByRole("button", { name: "Remove screenshot.png" })).toBeInTheDocument();
  });
});
