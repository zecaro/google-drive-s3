import { AwsClient } from "aws4fetch";
import { expect, it, vi } from "vitest";

import worker from "../src/index";

function kv() {
    const storage = new Map<string, string>();
    return {
        get: vi.fn(async (key: string) => storage.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
        delete: vi.fn(async (key: string) => void storage.delete(key)),
        list: vi.fn(async () => ({ keys: [] })),
    };
}

const ENV = {
    ACCESS_KEY: "test-access-key",
    SECRET_KEY: "test-secret-key",
    REGION: "auto",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
    AUTH_KV: kv(),
    FOLDER_CACHE: kv(),
    ALLOWED_BUCKETS: "test-bucket",
};

const CTX = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

it("repassa Range ao Drive e devolve 206 com Content-Range", async () => {
    const original = globalThis.fetch;
    let seenRange: string | null = null;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (target.includes("oauth2.googleapis.com/token")) {
            return new Response(JSON.stringify({ access_token: "mock", expires_in: 3600 }), { status: 200 });
        }
        if (target.includes("mimeType='application/vnd.google-apps.folder'")) {
            return new Response(JSON.stringify({ files: [{ id: "folder-1", name: "test-bucket" }] }), { status: 200 });
        }
        if (target.includes("in parents")) {
            return new Response(
                JSON.stringify({ files: [{ id: "file-1", name: "video.mp4", mimeType: "video/mp4", size: "11" }] }),
                { status: 200 },
            );
        }
        if (target.includes("alt=media")) {
            const headers = new Headers(init?.headers as HeadersInit);
            seenRange = headers.get("Range");
            return new Response("Hel", {
                status: 206,
                headers: { "Content-Range": "bytes 0-2/11", "Content-Type": "video/mp4" },
            });
        }
        return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });
        const signed = await aws4.sign("https://s3-api.example.com/test-bucket/video.mp4", {
            method: "GET",
            headers: { Range: "bytes=0-2" },
        });
        const res = await worker.fetch(signed, ENV as never, CTX as never);

        expect(seenRange).toBe("bytes=0-2");
        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Range")).toBe("bytes 0-2/11");
        expect(res.headers.get("Content-Length")).toBe("3");
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    } finally {
        globalThis.fetch = original;
    }
});
