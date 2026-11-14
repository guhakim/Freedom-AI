#!/usr/bin/env node
// 안내·블로그·정책 페이지(guide, faq, blog, privacy, terms)를 언어별로 만든다.
//   한국어 → 사이트 루트 (guide.html, blog/…)
//   영어   → en/ (en/guide.html, en/blog/…)
//   일본어 → ja/
// 내용은 tools/pages/{ko,en,ja}.js 에 있다. 글을 고치거나 추가한 뒤 `node tools/build-pages.js`.
// 본문 안의 "@/" 는 사이트 루트를 뜻한다 (예: @/app.html, @/#about) — 언어 폴더 깊이에 맞게 바뀐다.
//
// 랜딩 페이지(index.html)는 한 주소에서 버튼으로 언어를 바꾸고 localStorage 'fa_lang'에 기억한다.
// 이 페이지들은 검색엔진이 언어별로 따로 색인하도록 주소를 나누되, 같은 'fa_lang'을 읽어
// 랜딩에서 고른 언어의 주소로 옮겨 간다. 언어 버튼을 누르면 'fa_lang'도 함께 바꾼다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://freedomai-app.vercel.app';
const UPDATED = '2026-11-15';
const LANGS = ['ko', 'en', 'ja'];
const DIR = { ko: '', en: 'en/', ja: 'ja/' };
const LABEL = { ko: 'KO', en: 'EN', ja: 'JP' };
const NAME = { ko: '한국어', en: 'English', ja: '日本語' };

const content = Object.fromEntries(LANGS.map((l) => [l, require(`./pages/${l}.js`)]));

// 세 언어가 같은 페이지 목록을 갖는지 확인 — 하나라도 빠지면 언어 전환 링크가 깨진다
const files = (l) => [...content[l].pages, ...content[l].posts].map((p) => p.file).sort().join(',');
for (const l of LANGS) {
  if (files(l) !== files('ko')) throw new Error(`${l}: 페이지 목록이 한국어와 다르다\n${files(l)}\n${files('ko')}`);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render(lang, p) {
  const { ui } = content[lang];
  const rel = DIR[lang] + p.file;                         // 사이트 루트 기준 경로
  const depth = rel.split('/').length - 1;
  const root = depth ? '../'.repeat(depth) : '';          // 사이트 루트로 가는 상대 경로
  const home = depth - (lang === 'ko' ? 0 : 1);
  const langRoot = home ? '../'.repeat(home) : '';        // 이 언어의 최상위로 가는 상대 경로
  const cur = (k) => (p.nav === k ? ' aria-current="page"' : '');
  const url = (l) => `${SITE}/${DIR[l]}${p.file}`;
  const body = p.body.trim().replace(/(href|src)="@\//g, `$1="${root}`);
  const ld = p.article
    ? `\n<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'Article', headline: p.title, description: p.desc,
        inLanguage: lang, datePublished: p.article.date, dateModified: p.article.date,
        author: { '@type': 'Organization', name: 'Freedom AI' },
        publisher: { '@type': 'Organization', name: 'Freedom AI', logo: { '@type': 'ImageObject', url: SITE + '/logo.png' } },
        mainEntityOfPage: url(lang),
      })}</script>`
    : '';
  const switcher = LANGS.map((l) =>
    `<a href="${root}${DIR[l]}${p.file}" hreflang="${l}" lang="${l}" data-lang="${l}" title="${NAME[l]}"${l === lang ? ' aria-current="true"' : ''}>${LABEL[l]}</a>`).join('');

  return `<!DOCTYPE html>
<html lang="${ui.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>
// 랜딩 페이지에서 고른 언어(fa_lang)와 이 페이지 언어가 다르면 그 언어 주소로 옮긴다
(function () {
  var here = '${lang}', want;
  try { want = localStorage.getItem('fa_lang'); } catch (e) {}
  if (!want || want === here || ['ko', 'en', 'ja'].indexOf(want) < 0) return;
  var dirs = { ko: '', en: 'en/', ja: 'ja/' };
  location.replace('${root}' + dirs[want] + '${p.file}' + location.hash);
})();
</script>
<title>${esc(p.title)} | ${ui.suffix}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${url(lang)}">
${LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${url(l)}">`).join('\n')}
<link rel="alternate" hreflang="x-default" href="${url('ko')}">
<meta property="og:type" content="${p.article ? 'article' : 'website'}">
<meta property="og:site_name" content="Freedom AI">
<meta property="og:locale" content="${ui.locale}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${url(lang)}">
<meta property="og:image" content="${SITE}/logo.png">
<link rel="icon" type="image/png" href="${root}logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${lang === 'ja' ? 'Noto+Sans+JP' : 'Noto+Sans+KR'}:wght@400;500;700&display=swap">
<link rel="stylesheet" href="${root}fonts.css">
<link rel="stylesheet" href="${root}pages.css">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3217274047131813" crossorigin="anonymous"></script>${ld}
</head>
<body>
<header class="site-header">
  <a href="${root}" class="logo"><img src="${root}logo-mark.png" alt=""><span>Freedom Ai</span></a>
  <nav class="site-nav" aria-label="${ui.nav.menu}">
    <a href="${langRoot}guide.html"${cur('guide')}>${ui.nav.guide}</a>
    <a href="${langRoot}blog.html"${cur('blog')}>${ui.nav.blog}</a>
    <a href="${langRoot}faq.html"${cur('faq')}>${ui.nav.faq}</a>
    <span class="lang-switch" role="group" aria-label="Language">${switcher}</span>
    <a href="${root}app.html" class="cta">${ui.nav.start}</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <div class="inner">
    <nav aria-label="${ui.nav.footer}">
      <a href="${root}">${ui.footer.home}</a>
      <a href="${langRoot}guide.html">${ui.nav.guide}</a>
      <a href="${langRoot}blog.html">${ui.nav.blog}</a>
      <a href="${langRoot}faq.html">${ui.nav.faq}</a>
      <a href="${langRoot}privacy.html">${ui.footer.privacy}</a>
      <a href="${langRoot}terms.html">${ui.footer.terms}</a>
    </nav>
    <p>© 2026 Freedom AI. All rights reserved.</p>
  </div>
</footer>
<script>
// 언어 버튼을 누르면 랜딩 페이지와 같은 저장값도 바꿔, 위의 자동 이동이 되돌리지 않게 한다
document.querySelectorAll('.lang-switch a').forEach(function (a) {
  a.addEventListener('click', function () { try { localStorage.setItem('fa_lang', a.dataset.lang); } catch (e) {} });
});
</script>
</body>
</html>
`;
}

const written = [];
for (const lang of LANGS) {
  const { ui, pages, posts } = content[lang];
  const list = [...pages, ...posts, {
    file: 'blog.html', nav: 'blog', title: ui.blog.title, desc: ui.blog.desc,
    body: `<span class="kicker">${ui.blog.kicker}</span>
<h1>${ui.blog.h1}</h1>
<p class="lead">${ui.blog.lead}</p>
<ul class="post-list">
${posts.map((p) => `  <li><a href="${p.file}"><span class="meta">${p.article.date}</span><h2>${p.title}</h2><p>${p.desc}</p></a></li>`).join('\n')}
</ul>`,
  }];
  for (const p of list) {
    const rel = DIR[lang] + p.file;
    const out = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, render(lang, p));
    written.push(rel);
  }
}

fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['', ...written].map((u) => `  <url>\n    <loc>${SITE}/${u}</loc>\n    <lastmod>${UPDATED}</lastmod>\n  </url>`).join('\n')}
</urlset>
`);
console.log(`${written.length} pages + sitemap.xml`);
