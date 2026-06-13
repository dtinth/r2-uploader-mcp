import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

interface Env {
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  R2_PUBLIC_DOMAIN: string;
  ALLOWED_EXTS?: string;
  UPLOAD_PREFIX?: string;
  BUCKET: R2Bucket;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------

async function verifyAccessJwt(token: string, teamDomain: string, policyAud: string): Promise<void> {
  const { keys } = await fetch(`${teamDomain}/cdn-cgi/access/certs`)
    .then((r) => r.json() as Promise<{ keys: JsonWebKey[] }>);

  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Malformed JWT");

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(sigB64);

  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk", jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false, ["verify"]
      );
      if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput)) continue;

      const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as {
        aud: string[];
        exp: number;
      };
      if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("JWT expired");
      if (!payload.aud.includes(policyAud)) throw new Error("JWT audience mismatch");
      return;
    } catch (_) { /* try next key */ }
  }
  throw new Error("JWT verification failed");
}

function base64UrlDecode(str: string): ArrayBuffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0)).buffer;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_EXTS = ".png,.jpg,.jpeg,.gif,.webp";
const DEFAULT_UPLOAD_PREFIX = "uploads/";

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "r2-uploader", version: "1.0.0" });

  const allowedExts = (env.ALLOWED_EXTS || DEFAULT_ALLOWED_EXTS)
    .split(",")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);

  const uploadPrefix = env.UPLOAD_PREFIX || DEFAULT_UPLOAD_PREFIX;

  server.tool(
    "get_upload_url",
    `Get a presigned PUT URL to upload a file to R2, plus the permanent public URL to embed in a GitHub PR description. Allowed: ${allowedExts.join(", ")}`,
    {
      filename: z.string().describe(
        `File name e.g. 'before.png'. Allowed: ${allowedExts.join(" ")}`
      ),
    },
    async ({ filename }) => {
      const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
      if (!allowedExts.includes(ext)) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unsupported type '${ext}'. Allowed: ${allowedExts.join(", ")}` }],
        };
      }

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
      const key = `${uploadPrefix}${date}/${crypto.randomUUID()}${ext}`;
      const putUrl = await (env.BUCKET as any).createPresignedUrl("PUT", key, { expiresIn: 300 });
      const publicUrl = `https://${env.R2_PUBLIC_DOMAIN}/${key}`;

      return {
        content: [{
          type: "text" as const,
          text: [
            `**Upload** (expires in 5 min):`,
            `\`\`\`bash`,
            `curl -X PUT -T /path/to/${filename} "${putUrl}"`,
            `\`\`\``,
            ``,
            `**Embed in PR**:`,
            `\`\`\`markdown`,
            `![${filename}](${publicUrl})`,
            `\`\`\``,
          ].join("\n"),
        }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!jwt) {
      return new Response("Unauthorized: missing Cf-Access-Jwt-Assertion", { status: 401 });
    }
    try {
      await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD);
    } catch (err) {
      return new Response(`Forbidden: ${(err as Error).message}`, { status: 403 });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildMcpServer(env).connect(transport);
    return transport.handleRequest(request);
  },
};
