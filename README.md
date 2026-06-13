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

Upload URLs are presigned using the [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
(via [aws4fetch](https://github.com/mhart/aws4fetch)) with an R2 API token —
the Worker doesn't use an `r2_buckets` binding.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dtinth/r2-uploader-mcp)

Everything below is post-deploy dashboard configuration — no code edits or
redeploys needed.

### 1. Create the R2 bucket

```bash
wrangler r2 bucket create r2-uploads
```

Enable public access in the Cloudflare dashboard:
**R2 → r2-uploads → Settings → Public Access → Enable**

Copy the public bucket URL (looks like `pub-abc123.r2.dev`).

### 2. Create an R2 API token

1. Go to **R2 → Overview → Manage API tokens** (or **R2 → r2-uploads → Settings → API tokens**)
2. **Create API token**
3. Permissions: **Object Read & Write**, scoped to the `r2-uploads` bucket
4. Copy the **Access Key ID**, **Secret Access Key**, and your **Account ID** (shown in the token details / R2 overview sidebar)

### 3. Create a Cloudflare Access self-hosted app

1. Go to [Cloudflare One](https://one.dash.cloudflare.com) → **Access controls → Applications**
2. **Add an application → Self-hosted and private**
3. Under **Destinations → Public hostnames**, enter your deployed Worker's subdomain and domain (e.g. `r2-uploader-mcp` . `<YOUR_SUBDOMAIN>.workers.dev`)
4. Name: `R2 Uploader MCP`
5. Add a policy: allow your email address (or email domain)
6. Configure your IdP (Google, GitHub, OTP, etc.)
7. On the **Additional settings** tab, turn on **Managed OAuth** — this lets non-browser MCP clients (like Claude Code) authenticate via a standard OAuth 2.0 flow instead of a browser redirect
8. To connect from **claude.ai** (web), add `https://claude.ai/api/mcp/auth_callback` as an allowed **redirect URI** in the Managed OAuth settings
9. Save — copy the **AUD tag** from the app's Basic Information (under Additional settings)

### 4. Set the Worker's secrets

In the Cloudflare dashboard: **Workers & Pages → r2-uploader-mcp → Settings → Variables and Secrets**,
add each of these as a **Secret** (not a plaintext Variable):

| Secret | Value |
|---|---|
| `TEAM_DOMAIN` | `https://yourteam.cloudflareaccess.com` |
| `POLICY_AUD` | the AUD tag from step 3 |
| `R2_PUBLIC_DOMAIN` | the public bucket domain from step 1 (e.g. `pub-abc123def456.r2.dev`) |
| `R2_ACCOUNT_ID` | your Cloudflare account ID from step 2 |
| `R2_BUCKET_NAME` | `r2-uploads` |
| `R2_ACCESS_KEY_ID` | Access Key ID from step 2 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key from step 2 |
| `ALLOWED_EXTS` *(optional)* | comma-separated extensions, e.g. `.png,.jpg,.webm,.zip,.html`. Defaults to `.png,.jpg,.jpeg,.gif,.webp` |
| `UPLOAD_PREFIX` *(optional)* | key prefix for uploaded objects, e.g. `screenshots/`. Defaults to `uploads/` |

These take effect immediately — no redeploy required. Using Secrets (rather
than the `vars` block in `wrangler.jsonc`) means they **won't be reset** by
the automatic redeploys from the Workers Builds pipeline the deploy button
sets up.

The dashboard's "Edit variables" view has a bulk-paste mode — fill in the
placeholders below and paste the whole block in:

```
TEAM_DOMAIN=https://yourteam.cloudflareaccess.com
POLICY_AUD=<AUD tag from Access app>
R2_PUBLIC_DOMAIN=pub-abc123def456.r2.dev
R2_ACCOUNT_ID=<your Cloudflare account ID>
R2_BUCKET_NAME=r2-uploads
R2_ACCESS_KEY_ID=<R2 API token access key id>
R2_SECRET_ACCESS_KEY=<R2 API token secret access key>
ALLOWED_EXTS=.png,.jpg,.jpeg,.gif,.webp
UPLOAD_PREFIX=uploads/
```

`ALLOWED_EXTS` and `UPLOAD_PREFIX` are optional — drop those two lines to use
the defaults shown above. Make sure each one is added as a **Secret**, not a
plaintext Variable.

### 5. Connect to Claude

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
3. Embed `![screenshot](https://pub-xxx.r2.dev/uploads/...)` in the PR body using the returned public URL

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
- Public URLs are unguessable (random UUID per file) but not access-controlled — anyone with the link can view the file
- Access logs every connection attempt in the Cloudflare One dashboard
- The Worker logs each request (method, path, authenticated email or rejection reason) and each `get_upload_url` call to the console — view live with `wrangler tail` or in **Workers & Pages → r2-uploader-mcp → Logs**
