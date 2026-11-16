# Glance AI website

The marketing site for **Glance AI**, the open-source AI interview assistant that stays out of screen shares.

**Vercel:** [glance-ai-hazel.vercel.app](https://glance-ai-hazel.vercel.app)  
**Netlify mirror:** [glance-ai-633.netlify.app](https://glance-ai-633.netlify.app)

## What is here

- A CSS-composited 3D hero: the real product demo plays inside a floating, pointer-tilted panel, with orbit rings, a grid floor, drifting shards and a scanline. No WebGL context means no GPU startup hitch.
- Scroll choreography with [GSAP](https://github.com/greensock/GSAP) + ScrollTrigger.
- Smooth scrolling with [Lenis](https://github.com/darkroomengineering/lenis).
- A working product video player, capture-view toggle, hotkey board, comparison table and FAQ, with no UI framework.
- Self-hosted fonts (Manrope + Instrument Serif) and media. No cookies, analytics, or third-party runtime requests.

## Run locally

```bash
cd website
npm install
npm run dev
```

Open the URL Vite prints (default `http://127.0.0.1:5173`).

```bash
npm run build     # production build in website/dist
npm run preview   # serve the production build locally
```

## Deploy

### Vercel

Deployed at **<https://glance-ai-hazel.vercel.app>** (project `yaggus-projects/glance-ai`).

```bash
cd website
npm run deploy:vercel
```

First-time setup: `npx vercel login`, then `vercel link --project glance-ai`. Or import the repository in the Vercel dashboard. Framework preset: **Vite**, build command: `npm run build`, output directory: `dist`.

### Netlify

The site is also live on Netlify on the free plan, at a free `*.netlify.app` subdomain:

```bash
cd website
npm run build
netlify deploy --site glance-ai-633 --dir dist --prod --no-build
```

Project dashboard: <https://app.netlify.com/projects/glance-ai-633>

For a fresh Netlify account:

```bash
npx netlify-cli login
npx netlify-cli sites:create --name your-site-name
npm run build
npx netlify-cli deploy --dir dist --prod
```

## The honest answer on “free domain, unlimited”

**There is no provider that gives you unlimited free custom domains.** Custom TLDs (`.com`, `.io`, `.ai`) are rented yearly from a registrar, typically $10 to $40 per year. What is free and effectively unlimited is hosting plus a provider subdomain:

| Option | Free address | Free-plan reality |
|---|---|---|
| **Vercel** (primary) | `glance-ai-hazel.vercel.app` | Free hobby plan; static hosting, instant rollbacks, SSL. |
| **Netlify** (mirror) | `glance-ai-633.netlify.app` | Free credits each month; custom domains + SSL included. |
| **Cloudflare Pages** | `your-project.pages.dev` | Closest to “unlimited”: unlimited sites, seats, requests and bandwidth; 500 builds/month; 100 custom domains per project. |
| **GitHub Pages** | `username.github.io/repo` | 1 GB site, ~100 GB/month soft bandwidth. Static only. |
| **Surge** | `your-name.surge.sh` | Unlimited publishing; basic SSL; CLI-only. |
| **is-a.dev / js.org** | `name.is-a.dev` / `name.js.org` | Free third-level domains via a GitHub PR. Manual review, one per project, not unlimited. |

Cloudflare Pages is the best fit if “unlimited” is the priority: <https://developers.cloudflare.com/pages/platform/limits/>.

```bash
# Cloudflare Pages alternative (unlimited requests/bandwidth on free)
npm run build
npx wrangler pages deploy dist --project-name glance-ai
```

For a custom domain, point DNS at Vercel:

- `www` → `CNAME` → `cname.vercel-dns.com`
- apex (`example.com`) → `A` → `76.76.21.21`, or move the nameservers to Vercel.

Then add the domain in **Vercel → Project → Domains**. TLS is issued automatically and is free.

After attaching a custom domain, update the absolute URLs in `index.html` (canonical and Open Graph, around line 10), `public/robots.txt` and `public/sitemap.xml`, then rebuild and redeploy.

## Media

The real demo was converted from the repository's `assets/demo.gif`:

```bash
ffmpeg -i assets/demo.gif -c:v libx264 -pix_fmt yuv420p -crf 22 \
  -movflags +faststart -an website/public/media/demo.mp4
```

`demo.mp4` is the full-quality asset for the main player. `demo-3d.mp4` is a 640 px, 161 KB version used by the hero panel; it is small enough to decode without stalling scroll. The poster frame is `demo-poster.jpg`.

## Content and claims

Product claims, hotkeys, limits and comparison rows are taken from the repository README and are deliberately scoped:

- “0 pixels” means supported screen-capture paths (GDI, WGC, `getDisplayMedia`) on Windows 10 2004+.
- The site says plainly that purpose-built proctoring/EDR can still detect the window; see the “Where the line is” note.
- No testimonials, user counts, or benchmarks are invented.
- “Unlimited free domain” is not promised. See the table above.

## Credits

- [GSAP](https://github.com/greensock/GSAP): standard GSAP license
- [Lenis](https://github.com/darkroomengineering/lenis): MIT
- CSS 3D transforms: native, no runtime library
- Manrope and Instrument Serif: SIL Open Font License
- Demo capture, logo and screenshots: Glance AI

Glance AI is MIT licensed. The website is part of the project repository.
