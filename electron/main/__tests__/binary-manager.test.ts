// @vitest-environment node
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicError } from "../music/music-error.ts";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  userDataPath: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userDataPath,
  },
}));

vi.mock("node:https", () => ({
  default: { get: mocks.get },
}));

import { downloadBinaries, getBinaryInfo } from "../music/binary-manager.ts";

interface MockResponse {
  status: number;
  body?: string | Buffer;
  location?: string;
}

const YT_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_API = "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest";
const YT_URL = "https://github.com/yt-dlp/yt-dlp/releases/download/v1/yt-dlp.exe";
const YT_CHECKSUM_URL = "https://github.com/yt-dlp/yt-dlp/releases/download/v1/SHA2-256SUMS";
const FFMPEG_URL = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/v1/ffmpeg-win64.zip";
const FFMPEG_CHECKSUM_URL = `${FFMPEG_URL}.sha256`;

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-binary-manager-"));

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function releaseBody(assetUrl: string, name: string): string {
  return JSON.stringify({
    assets: [{ name, size: 10, browser_download_url: assetUrl }],
  });
}

function installRoutes(routes: Map<string, MockResponse | MockResponse[]>): void {
  mocks.get.mockImplementation((url: string, _options: unknown, callback: (response: PassThrough) => void) => {
    const configured = routes.get(String(url));
    const responseConfig = Array.isArray(configured) ? configured.shift() : configured;
    const request = new EventEmitter() as EventEmitter & { destroy: (error?: Error) => void };
    request.destroy = (error?: Error) => {
      if (error) request.emit("error", error);
    };

    queueMicrotask(() => {
      if (!responseConfig) {
        request.emit("error", new Error(`No mock response for ${String(url)}`));
        return;
      }

      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = responseConfig.status;
      response.headers = responseConfig.location ? { location: responseConfig.location } : {};
      callback(response);
      response.end(responseConfig.body ?? "");
    });

    return request;
  });
}

function baseRoutes(): Map<string, MockResponse | MockResponse[]> {
  return new Map([
    [YT_API, { status: 200, body: releaseBody(YT_URL, "yt-dlp.exe") }],
    [FFMPEG_API, { status: 200, body: releaseBody(FFMPEG_URL, "ffmpeg-win64.zip") }],
  ]);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.userDataPath = path.join(testRoot, crypto.randomUUID());
  fs.mkdirSync(mocks.userDataPath, { recursive: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("binary checksum verification", () => {
  it("fails closed with CHECKSUM_UNAVAILABLE when a checksum file cannot be fetched", async () => {
    const routes = baseRoutes();
    routes.set(YT_URL, { status: 200, body: "yt-dlp" });
    routes.set(YT_CHECKSUM_URL, { status: 404 });
    installRoutes(routes);

    await expect(downloadBinaries(vi.fn())).rejects.toMatchObject({
      name: "MusicError",
      code: "CHECKSUM_UNAVAILABLE",
    });
    expect(fs.existsSync(path.join(mocks.userDataPath, "bin", "yt-dlp.exe"))).toBe(false);
  });

  it("fails closed when the checksum manifest lacks the downloaded filename", async () => {
    const routes = baseRoutes();
    routes.set(YT_URL, { status: 200, body: "yt-dlp" });
    routes.set(YT_CHECKSUM_URL, { status: 200, body: `${sha256("yt-dlp")}  another-file.exe\n` });
    installRoutes(routes);

    await expect(downloadBinaries(vi.fn())).rejects.toMatchObject({ code: "CHECKSUM_UNAVAILABLE" });
  });

  it("keeps a confirmed hash mismatch distinct and hashes through a file stream", async () => {
    const routes = baseRoutes();
    routes.set(YT_URL, { status: 200, body: "yt-dlp" });
    routes.set(YT_CHECKSUM_URL, { status: 200, body: `${"0".repeat(64)}  yt-dlp.exe\n` });
    installRoutes(routes);
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    try {
      await expect(downloadBinaries(vi.fn())).rejects.toMatchObject({ code: "HASH_MISMATCH" });
      const tmpPath = path.join(mocks.userDataPath, "bin", "yt-dlp.exe.tmp");
      expect(createReadStreamSpy).toHaveBeenCalledWith(tmpPath);
      expect(readFileSyncSpy.mock.calls.some(([file]) => file === tmpPath)).toBe(false);
    } finally {
      createReadStreamSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  });

  it("classifies a local hashing failure as unavailable verification", async () => {
    const routes = baseRoutes();
    routes.set(YT_URL, { status: 200, body: "yt-dlp" });
    routes.set(YT_CHECKSUM_URL, { status: 200, body: `${sha256("yt-dlp")}  yt-dlp.exe\n` });
    installRoutes(routes);
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementationOnce(() => {
      throw new Error("file cannot be read");
    });

    try {
      await expect(downloadBinaries(vi.fn())).rejects.toMatchObject({ code: "CHECKSUM_UNAVAILABLE" });
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it("rejects an ffmpeg checksum for a different archive instead of trusting its first token", async () => {
    const ytDlp = Buffer.from("yt-dlp");
    const ffmpegArchive = Buffer.from("not-needed-before-verification");
    const routes = baseRoutes();
    routes.set(YT_URL, { status: 200, body: ytDlp });
    routes.set(YT_CHECKSUM_URL, { status: 200, body: `${sha256(ytDlp)}  yt-dlp.exe\n` });
    routes.set(FFMPEG_URL, { status: 200, body: ffmpegArchive });
    routes.set(FFMPEG_CHECKSUM_URL, {
      status: 200,
      body: `${sha256(ffmpegArchive)}  different-archive.zip\n`,
    });
    installRoutes(routes);

    await expect(downloadBinaries(vi.fn())).rejects.toMatchObject({ code: "CHECKSUM_UNAVAILABLE" });
  });
});

describe("binary download redirects", () => {
  it("rejects redirects to hosts outside the GitHub release delivery boundary", async () => {
    const routes = baseRoutes();
    routes.set(YT_API, { status: 302, location: "https://evil.example/releases/latest" });
    installRoutes(routes);

    const info = await getBinaryInfo();

    expect(info.error).toContain("Redirect host is not permitted");
    expect(mocks.get).not.toHaveBeenCalledWith(
      "https://evil.example/releases/latest",
      expect.anything(),
      expect.anything(),
    );
  });

  it("stops redirect loops after five hops", async () => {
    const loopUrl = "https://api.github.com/loop";
    const routes = baseRoutes();
    routes.set(YT_API, { status: 302, location: loopUrl });
    routes.set(loopUrl, Array.from({ length: 6 }, () => ({ status: 302, location: loopUrl })));
    installRoutes(routes);

    const info = await getBinaryInfo();

    expect(info.error).toContain("Too many redirects");
    expect(mocks.get.mock.calls.filter(([url]) => url === loopUrl)).toHaveLength(5);
  });
});

it("uses MusicError for verification failures", () => {
  expect(new MusicError("unavailable", "CHECKSUM_UNAVAILABLE")).toBeInstanceOf(MusicError);
});
