import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AwsClient } from "aws4fetch";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

interface Env {
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  R2_PUBLIC_DOMAIN: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  ALLOWED_EXTS?: string;
  UPLOAD_PREFIX?: string;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------

// Reused across requests in the same isolate so the JWKS is cached
// (with jose's built-in cooldown) instead of refetched every time.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyAccessJwt(token: string, teamDomain: string, policyAud: string): Promise<string | undefined> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: teamDomain,
    audience: policyAud,
  });
  return typeof payload.email === "string" ? payload.email : undefined;
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
    `Get a presigned PUT URL to upload a file to R2, plus its permanent public URL. The public URL is unguessable (random UUID) but not access-controlled — anyone with the link can view it. Use when the user wants a file available on the internet, for example, when adding screenshots into a GitHub PR. Allowed: ${allowedExts.join(", ")}`,
    {
      filename: z.string().describe(
        `File name e.g. 'before.png'. Allowed: ${allowedExts.join(" ")}`
      ),
    },
    async ({ filename }) => {
      const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
      if (!allowedExts.includes(ext)) {
        console.log(`get_upload_url(${filename}) -> rejected, unsupported type '${ext}'`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unsupported type '${ext}'. Allowed: ${allowedExts.join(", ")}` }],
        };
      }

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
      const key = `${uploadPrefix}${date}/${crypto.randomUUID()}${ext}`;
      console.log(`get_upload_url(${filename}) -> ${key}`);

      const r2 = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });
      const signUrl = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
      signUrl.searchParams.set("X-Amz-Expires", "300");
      const signed = await r2.sign(signUrl, { method: "PUT", aws: { signQuery: true } });
      const putUrl = signed.url;

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
            `**Public URL**: ${publicUrl}`,
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
    const { method } = request;
    const { pathname } = new URL(request.url);

    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
      console.log(`${method} ${pathname} -> 500 (TEAM_DOMAIN/POLICY_AUD not configured)`);
      return new Response("Server misconfigured: TEAM_DOMAIN and/or POLICY_AUD are not set", { status: 500 });
    }

    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!jwt) {
      console.log(`${method} ${pathname} -> 401 (missing Cf-Access-Jwt-Assertion)`);
      return new Response("Unauthorized: missing Cf-Access-Jwt-Assertion", { status: 401 });
    }

    let email: string | undefined;
    try {
      email = await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD);
    } catch (err) {
      console.log(`${method} ${pathname} -> 403 (${(err as Error).message})`);
      return new Response(`Forbidden: ${(err as Error).message}`, { status: 403 });
    }

    console.log(`${method} ${pathname} <- ${email}`);

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildMcpServer(env).connect(transport);
    return transport.handleRequest(request);
  },
};
