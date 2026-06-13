# r2-uploader-mcp

MCP server for uploading PR screenshots to Cloudflare R2, secured by Cloudflare Access.

Claude Code calls `get_upload_url`, gets a presigned PUT URL, uploads the file
with `curl`, then embeds the public URL in the PR description. No binary data
goes through MCP — clean and fast.

## Architecture

```
Claude (chat/code)
  └── MCP tool call: get_upload_url("before.png")
        └── Worker generates R2 presigned PUT URL + public URL
              └── Claude Code: curl -X PUT -T before.png "<put_url>"
                    └── R2 stores file, public URL embeds in PR markdown
```

Auth flow:
```
Claude → Cloudflare Access OAuth dance → JWT injected as Cf-Access-Jwt-Assertion
Worker verifies JWT (issuer, audience, expiry) → serves MCP
```

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dtinth/r2-uploader-mcp)

This creates the Worker and the `r2-uploads` R2 bucket in your account.
Everything below is post-deploy dashboard configuration — no code edits or
redeploys needed.

### 1. Enable public access on the R2 bucket

**R2 → r2-uploads → Settings → Public Access → Enable**

Copy the public bucket URL (looks like `pub-abc123.r2.dev`).

### 2. Create a Cloudflare Access self-hosted app

1. Go to [Cloudflare One](https://one.dash.cloudflare.com) → **Access controls → Applications**
2. **Add an application → Self-hosted**
3. Name: `R2 Uploader MCP`
4. Application domain: `r2-uploader-mcp.<YOUR_SUBDOMAIN>.workers.dev` (your deployed Worker's URL)
5. Add a policy: allow your email address (or email domain)
6. Configure your IdP (Google, GitHub, OTP, etc.)
7. Save — copy the **AUD tag** from the app's Basic Information

### 3. Set the Worker's variables

In the Cloudflare dashboard: **Workers & Pages → r2-uploader-mcp → Settings → Variables and Secrets**, set:

| Variable | Value |
|---|---|
| `TEAM_DOMAIN` | `https://yourteam.cloudflareaccess.com` |
| `POLICY_AUD` | the AUD tag from step 2 |
| `R2_PUBLIC_DOMAIN` | the public bucket domain from step 1 (e.g. `pub-abc123def456.r2.dev`) |
| `ALLOWED_EXTS` *(optional)* | comma-separated extensions, e.g. `.png,.jpg,.webm,.zip,.html`. Defaults to `.png,.jpg,.jpeg,.gif,.webp` |
| `UPLOAD_PREFIX` *(optional)* | key prefix for uploaded objects, e.g. `screenshots/`. Defaults to `uploads/` |

These take effect immediately — no redeploy required.

### 4. Connect to Claude

In Claude settings → MCP → Add server:
```
https://r2-uploader-mcp.<YOUR_SUBDOMAIN>.workers.dev/mcp
```

Claude will initiate the Access OAuth flow the first time you connect.

---

## Usage

### In Claude Code

Tell Claude Code to include a screenshot in the PR:

```
Take a screenshot of the rendered UI, upload it, and include it in the PR description.
```

Claude Code will:
1. Call `get_upload_url("screenshot.png")`
2. Run the returned `curl` command to upload
3. Embed `![screenshot](https://pub-xxx.r2.dev/screenshots/...)` in the PR body

### Tools

| Tool | Description |
|------|-------------|
| `get_upload_url(filename)` | Returns presigned PUT URL + public URL + ready-to-run curl command |

---

## Notes

- **Presigned URLs expire in 5 minutes** — Claude Code should upload immediately after receiving them
- **File types allowed**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` by default — configurable via the `ALLOWED_EXTS` variable
- **Keys are namespaced** as `uploads/<date>/<uuid><ext>` by default — configurable via the `UPLOAD_PREFIX` variable
- The R2 public bucket URL is permanent — uploaded files don't expire
- Access logs every connection attempt in the Cloudflare One dashboard
