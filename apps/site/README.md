# Relayvora website

The public-facing Relayvora website. Plain HTML, CSS, and JavaScript with no build step, third-party scripts, external fonts, analytics, or runtime dependencies. Covered by the repository's MIT license.

## Preview

From the repository root:

```sh
npm run site:dev
```

Open http://127.0.0.1:4173. Set `PORT` to use another port. You can also open `index.html` directly; clipboard support depends on your browser.

## Deploy to GitHub Pages

1. Push these changes to the repository's `main` branch.
2. In GitHub, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
3. Run **CI** from the Actions tab if the initial push preceded enabling Pages. Successful pushes to `main` deploy automatically after website validation and the complete CLI build/test matrix pass. Pull requests validate the website without deploying it.

The workflow uploads only `index.html`, `404.html`, `styles.css`, `site.js`, `favicon.svg`, `og-image.png` (the link-preview image), `sitemap.xml`, `llms.txt` (a plain summary for AI search tools), and the guide pages (`claude-code-usage-limit/`, `switch-claude-code-codex/`, `mcp-server/`). A new guide page also needs adding to that list, to `sitemap.xml`, and to the footer links. It does not upload the repository, local project state, preview server, or development files. Relative asset paths support project hosting at `https://Dagimassefa.github.io/Relayvora/` and custom domains.

## Content and design

- Product claims, commands, requirements, privacy details, and benchmark numbers come from the root README and CLI source.
- The palette comes from `apps/cli/src/ui/theme.ts`: ink, cyan, magenta, violet, and provider orange.
- The terminal interaction and handoff document are labelled illustrations. The demo never launches a real agent or runs commands.
- The page supports keyboard navigation, reduced motion, native FAQ disclosure controls, and narrow screens.
- Update published benchmark figures when the benchmark documentation changes.

The site deliberately uses system fonts so it works without font services or network requests. No installation is needed to edit it.
