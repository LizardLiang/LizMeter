import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ["dist/main/index.js"],
  });
});

test.afterAll(async () => {
  await app.close();
});

test("window opens with correct title", async () => {
  const window = await app.firstWindow();
  const title = await window.title();
  expect(title).toBe("LizMeter");
});

test("renders the heading", async () => {
  const window = await app.firstWindow();
  const heading = await window.locator("h1").textContent();
  expect(heading).toBe("LizMeter");
});
