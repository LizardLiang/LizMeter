// What is honestly testable about a widget in jsdom, and nothing more.
//
// jsdom performs no layout and fetches no images: the `<img>` below never loads, never decodes
// and never fires `error` on its own. So the failure test dispatches the event by hand, which
// proves the handler is wired -- not that a real broken attachment reaches it. How the image
// LOOKS, whether it flickers on keystroke, and whether a click lands the cursor where the user
// expects are all manual checks in a real Electron window.

import { describe, expect, it } from "vitest";
import { IMAGE_MAX_HEIGHT_PX, IMAGE_MISSING_CLASS, IMAGE_WIDGET_CLASS, ImageWidget } from "../ImageWidget.ts";

const SRC = "app-media://attachments/0123456789abcdef.png";

function imageIn(dom: HTMLElement): HTMLImageElement | null {
  return dom.querySelector("img");
}

describe("ImageWidget.eq", () => {
  it("compares equal to a widget with the same src and alt", () => {
    // This is the whole reason the class exists. Without it CodeMirror rebuilds the `<img>` on
    // every keystroke, so the image flickers and its decode is discarded while the user types.
    expect(new ImageWidget(SRC, "shot").eq(new ImageWidget(SRC, "shot"))).toBe(true);
  });

  it("compares unequal when the src differs", () => {
    expect(new ImageWidget(SRC, "shot").eq(new ImageWidget("https://x.com/b.png", "shot"))).toBe(false);
  });

  it("compares unequal when the alt differs", () => {
    // The alt is user-visible: it is the failure text and the accessible name.
    expect(new ImageWidget(SRC, "shot").eq(new ImageWidget(SRC, "other"))).toBe(false);
  });

  it("treats an empty alt as its own identity", () => {
    expect(new ImageWidget(SRC, "").eq(new ImageWidget(SRC, ""))).toBe(true);
    expect(new ImageWidget(SRC, "").eq(new ImageWidget(SRC, " "))).toBe(false);
  });
});

describe("ImageWidget.toDOM", () => {
  it("renders an img carrying the src and the alt", () => {
    const image = imageIn(new ImageWidget(SRC, "shot").toDOM());

    expect(image?.getAttribute("src")).toBe(SRC);
    expect(image?.getAttribute("alt")).toBe("shot");
  });

  it("bounds the image and defers its load", () => {
    // An unbounded screenshot pushes the rest of the note off screen, and the editor stops
    // looking like a text field.
    const image = imageIn(new ImageWidget(SRC, "shot").toDOM());

    expect(image?.style.maxWidth).toBe("100%");
    expect(image?.style.maxHeight).toBe(`${IMAGE_MAX_HEIGHT_PX}px`);
    expect(image?.getAttribute("loading")).toBe("lazy");
  });

  it("refuses to be dragged", () => {
    // Dragging the rendered image back into the editor would arrive at the drop handler as a
    // second copy of a file that is already stored.
    expect(imageIn(new ImageWidget(SRC, "shot").toDOM())?.draggable).toBe(false);
  });

  it("swaps in a placeholder when the image fails to load", () => {
    // Dispatched by hand: jsdom loads nothing, so a real `error` never arrives here. This
    // asserts the handler is wired, not that a missing attachment triggers it.
    const dom = new ImageWidget(SRC, "shot").toDOM();
    const image = imageIn(dom);

    image?.dispatchEvent(new Event("error"));

    expect(imageIn(dom)).toBeNull();
    expect(dom.querySelector(`.${IMAGE_MISSING_CLASS}`)?.textContent).toBe("Missing image: shot");
  });

  it("names the placeholder generically when there is no alt", () => {
    const dom = new ImageWidget(SRC, "").toDOM();

    imageIn(dom)?.dispatchEvent(new Event("error"));

    expect(dom.querySelector(`.${IMAGE_MISSING_CLASS}`)?.textContent).toBe("Missing image");
  });

  it("carries the widget class on its wrapper", () => {
    expect(new ImageWidget(SRC, "shot").toDOM().className).toBe(IMAGE_WIDGET_CLASS);
  });
});

describe("ImageWidget.ignoreEvent", () => {
  it("lets the editor handle events that land on the image", () => {
    // True would leave a click on the image doing nothing at all, because the widget sits
    // inside an atomic range the cursor cannot enter.
    expect(new ImageWidget(SRC, "shot").ignoreEvent()).toBe(false);
  });
});
