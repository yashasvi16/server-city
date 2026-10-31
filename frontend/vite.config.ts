import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { site } from './src/config/site.config';
import { renderResumeBody, listTBD, findPhoneNumbers } from './src/resume/render';

// Injects content from site.config.ts into the HTML at build time:
//  - resume.html gets the full prerendered resume (works with JS off).
//  - index.html gets the skip link target, and in single-file mode an
//    embedded copy of the resume so the one-file build is self-contained.
function siteContent(single: boolean): Plugin {
  return {
    name: 'site-content',
    buildStart() {
      const phones = findPhoneNumbers(site);
      if (phones.length) this.error(`site.config.ts looks like it contains a phone number: ${phones.join(', ')}`);
      const tbd = listTBD(site);
      if (tbd.length) this.warn(`TBD content hidden on the site (${tbd.length}): ${tbd.join(', ')}`);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const resumeHref = single ? '#resume' : './resume.html';
        const name = site.profile.name;
        html = html
          .replaceAll('%RESUME_HREF%', resumeHref)
          .replaceAll('%NAME%', name)
          .replaceAll('%ROLE%', site.profile.role)
          .replaceAll('%DESCRIPTION%', `${name}, ${site.profile.role}. ${site.profile.intro}`.replace(/"/g, '&quot;'));
        if (ctx.filename.endsWith('resume.html')) {
          html = html.replace('<!--RESUME-->', renderResumeBody(site, './'));
        } else {
          html = html.replace(
            '<!--RESUME-->',
            single ? `<div class="resume" id="resume-view" hidden>${renderResumeBody(site, './')}</div>` : '',
          );
        }
        return html;
      },
    },
  };
}

// Writes name.gz next to compressible build assets; the Go server serves them
// to clients that accept gzip (the meshopt city model shrinks ~60%).
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const dir = join(outDir, 'assets');
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        return;
      }
      for (const f of files) {
        if (!/\.(js|css|glb|svg|json)$/.test(f)) continue;
        const src = readFileSync(join(dir, f));
        const gz = gzipSync(src, { level: 9 });
        if (gz.length < src.length * 0.9) writeFileSync(join(dir, f + '.gz'), gz);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: [siteContent(single), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : process.env.NO_PRECOMPRESS ? [] : [precompress()])],
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single' : 'dist',
      reportCompressedSize: true,
      rollupOptions: single
        ? { input: resolve(__dirname, 'index.html') }
        : { input: { index: resolve(__dirname, 'index.html'), resume: resolve(__dirname, 'resume.html') } },
    },
    server: {
      // `npm run dev` talks to a local backend on :8080.
      proxy: {
        '/api': 'http://localhost:8080',
        '/ws': { target: 'ws://localhost:8080', ws: true },
      },
    },
  };
});
