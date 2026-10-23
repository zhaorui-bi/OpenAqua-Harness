#!/usr/bin/env node
// Brand the prebuilt Kimi Code web UI bundle for OpenAqua Harness.
// Copies engine's apps/kimi-code/dist-web into this package's web-ui/ and
// rewrites user-visible product-name strings + brand SVGs. URLs, HTTP headers
// (Kimi-Client-*), plan names (Kimi For Coding / Moonshot Coding Plan), kimi.com
// account wording and code identifiers are intentionally left untouched.

import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productRoot = path.resolve(pkgRoot, '..', '..', '..');
const SRC = path.resolve(pkgRoot, '..', 'kimi-code', 'dist-web');
const DST = path.join(pkgRoot, 'web-ui');
const FAVICON = path.join(productRoot, 'build', 'icon.ico');
const MARK = path.join(productRoot, 'build', 'logo-256.png');
const THEME = path.join(pkgRoot, 'theme', 'openaqua.css');
const PRODUCT_VERSION = JSON.parse(
  readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
).version;
const FONT_ASSET_DIR = 'openaqua-fonts';
const FONT_PACKAGES = [
  {
    name: '@fontsource-variable/cormorant-garamond',
    slug: 'cormorant-garamond',
    styles: ['wght.css', 'wght-italic.css'],
  },
  {
    name: '@fontsource-variable/noto-serif-sc',
    slug: 'noto-serif-sc',
    styles: ['index.css'],
  },
];

const TEXT_REPLACEMENTS = [
  [
    'Title generation unavailable — needs a managed Kimi Code login and at least one message',
    'Title generation unavailable — requires a managed account and at least one message',
  ],
  [
    '无法生成标题：需要登录 Kimi Code 托管账号，且会话中已有消息',
    '标题生成不可用：需要托管账号且会话中至少有一条消息',
  ],
  ['Kimi Code Web', 'OpenAqua Harness'],
  ['Kimi Code', 'OpenAqua Harness'],
  [
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />',
    '<meta name="theme-color" content="#f3fbfa" media="(prefers-color-scheme: light)" />',
  ],
  [
    '<meta name="theme-color" content="#121212" media="(prefers-color-scheme: dark)" />',
    '<meta name="theme-color" content="#0d2632" media="(prefers-color-scheme: dark)" />',
  ],
  ['The AI coding workbench for professional developers', 'The AI research workbench for evidence-grounded water-treatment design'],
  ['为专业开发者打造的 AI 编程工作台', '面向循证水处理工艺设计的 AI 科研工作台'],
  ['signIn:"Sign in"', 'signIn:"Set up model"'],
  ['signIn:"登录"', 'signIn:"配置模型"'],
  ['action:"Sign in"', 'action:"Set up model"'],
  ['action:"登录"', 'action:"配置模型"'],
  ['class:"wordmark",viewBox:"0 0 304.035 64"', 'class:"wordmark",viewBox:"0 0 330 82"'],
  [
    'light:"Moon bright",dark:"Moon dark",system:"System"',
    'light:"Light",dark:"Dark",system:"System"',
  ],
  // OpenAqua starts with its bright logo-aligned theme while preserving any
  // explicit user choice already stored by the upstream Web application.
  [
    'function vZe(){const e=kM(Ese);return e&&Mse.includes(e)?e:"system"}',
    'function vZe(){const e=kM(Ese);return e&&Mse.includes(e)?e:"light"}',
  ],
  [
    'const Cw={light:"#ffffff",dark:"#121212"}',
    'const Cw={light:"#f3fbfa",dark:"#0d2632"}',
  ],
  [
    'light:"月之亮面",dark:"月之暗面",system:"跟随系统"',
    'light:"浅色",dark:"深色",system:"跟随系统"',
  ],
  ['Kimi 服务器', 'OpenAqua 服务器'],
  ['Kimi server', 'OpenAqua server'],
  // pure API-key mode: drop the Account tab from the settings nav
  ['{id:"account",labelKey:"settings.tabs.account",icon:"user"},', ''],
  // the remaining providers group is the API-key one — label it accordingly
  ['groupCustom:"Custom providers"', 'groupCustom:"API providers"'],
  ['groupCustom:"自定义供应商"', 'groupCustom:"API 提供方"'],
  ['emptyCustom:"No custom providers yet"', 'emptyCustom:"No API providers yet"'],
  ['emptyCustom:"暂无自定义供应商"', 'emptyCustom:"暂无 API 提供方"'],
  // full de-kimi purge: subscription/account wording -> neutral (service
  // names like "Kimi For Coding" API presets and kimi.com URLs stay)
  ['kimiSubscription:"Kimi Subscription"', 'kimiSubscription:"Available models"'],
  ['kimiSubscription:"Kimi 订阅"', 'kimiSubscription:"可用模型"'],
  ['groupManaged:"Kimi Subscription"', 'groupManaged:"Available models"'],
  ['groupManaged:"Kimi 订阅"', 'groupManaged:"可用模型"'],
  ['defaultUserName:"Kimi 用户"', 'defaultUserName:"OpenAqua 用户"'],
  ['defaultUserName:"Kimi User"', 'defaultUserName:"OpenAqua User"'],
  ['loginKimi:"登录 Kimi"', 'loginKimi:"登录"'],
  ['loginKimi:"Sign in to Kimi"', 'loginKimi:"Sign in"'],
  ['kimiTitle:"登录 Kimi 账号"', 'kimiTitle:"登录账号"'],
  ['kimiTitle:"Sign in with Kimi"', 'kimiTitle:"Sign in"'],
  ['managedLoginTitle:"登录 Kimi 订阅"', 'managedLoginTitle:"登录订阅"'],
  ['managedLoginTitle:"Sign in to Kimi Subscription"', 'managedLoginTitle:"Sign in to Subscription"'],
  ['loggedInTitle:"已登录 Kimi 账号"', 'loggedInTitle:"已登录"'],
  ['loggedInTitle:"Logged in with Kimi"', 'loggedInTitle:"Signed in"'],
  ['oauthTitle:"登录 Kimi 账号"', 'oauthTitle:"登录账号"'],
  ['oauthTitle:"Sign in with Kimi"', 'oauthTitle:"Sign in"'],
  ['使用 Kimi 账号登录即可继续。', '登录后即可继续。'],
  ['Sign in with your Kimi account to continue.', 'Sign in to continue.'],
  ['登录 Kimi 账号并配置模型后，才能开始对话。', '配置模型后，才能开始对话。'],
  ['当前套餐暂不支持 Kimi 模型；升级会员', '当前套餐暂不支持该模型；升级会员'],
  ['This uses your Kimi subscription quota', 'This uses your subscription quota'],
  ['会消耗 Kimi 账号的订阅额度', '会消耗账号的订阅额度'],
  ['在浏览器中登录 Kimi', '在浏览器中登录'],
  ['Sign in to Kimi in the browser', 'Sign in via browser login'],
  ['kimiHint:"使用 Kimi 会员权益，开箱即用"', 'kimiHint:"使用订阅权益，开箱即用"'],
  ['kimiHint:"Ready out of the box with Kimi membership benefits"', 'kimiHint:"Ready out of the box"'],
  ['kimiCnHint:"Sign in with your kimi.com account"', 'kimiCnHint:"Sign in with your account"'],
  ['kimiOverseasHint:"Sign in with your kimi.ai account"', 'kimiOverseasHint:"Sign in with your account"'],
  ['managedLoginHint:"登录后使用 Kimi 系列模型，订阅额度自动同步。将在浏览器中完成授权。"', 'managedLoginHint:"登录后使用系列模型，订阅额度自动同步。将在浏览器中完成授权。"'],
  ['managedLoginHint:"Sign in to use Kimi models with automatic quota sync. Authorization completes in your browser."', 'managedLoginHint:"Sign in to use models with automatic quota sync. Authorization completes in your browser."'],
  ['requiredMessage:"Sign in to your Kimi account and set up a model to start chatting."', 'requiredMessage:"Set up a model to start chatting."'],
  ['Your current plan doesn\'t include Kimi models.', 'Your current plan doesn\'t include these models.'],
  // drop the engine's plugin catalog sections (official kimi plugins + the
  // third-party coding catalog) from Plugins settings — OpenAqua workflows
  // are delivered through its focused skills and MCP tools instead
  ['[{key:"official",title:p(t)("settings.plugins.official"),entries:p(o)},{key:"third-party",title:p(t)("settings.plugins.thirdParty"),entries:p(s)}]', '[]'],
  // pure API mode: remove the OAuth sign-in cards from the onboarding model step
  ['function IQ(e,t,n){return e==="unsupported"?[{titleKey:n.titleKey,hintKey:n.hintKey,disabled:!1}]:t.map(i=>({...i,disabled:e==="pending"}))}', 'function IQ(){return[]}'],
  // Every model-setup entry goes straight to Settings > Model Providers.
  // OpenAqua is API-provider based and must never open the upstream OAuth dialog.
  ['function a(){G3.value=!0}function l(){Vy.value=!0}', 'function a(){c()}function l(){Vy.value=!0}'],
  ['title:"Sign in to OpenAqua Harness"', 'title:"Configure model providers"'],
  ['title:"登录 OpenAqua Harness"', 'title:"配置模型提供方"'],
  // the no-model CTA leads to API provider setup — label it accordingly
  ['goToLogin:"Sign in"', 'goToLogin:"Set up model"'],
  ['goToLogin:"去登录"', 'goToLogin:"配置模型"'],
  ['requiredTitle:"Sign in required"', 'requiredTitle:"Model setup required"'],
  ['requiredTitle:"请先登录"', 'requiredTitle:"请先配置模型"'],
  ['rcLead:"This Remote Control session requires authorization. Sign in with your Kimi account to continue."', 'rcLead:"This Remote Control session requires authorization. Sign in to continue."'],
  ['rcLead:"远程控制功能需要登录后使用。使用 Kimi 账号登录即可继续。"', 'rcLead:"远程控制功能需要登录后使用。登录后即可继续。"'],
  // settings: remove the Lab tab
  [',{id:"lab",labelKey:"settings.tabs.lab",icon:"flask"}', ''],
  // About page: keep only "Version & updates" — drop Diagnostics and Agreements
  ['A("section",Vjt,[A("h3",Kjt,P(p(n)("settings.diagnostics")),1),A("div",Gjt,[A("div",Zjt,[A("span",Qjt,[qe(P(p(n)("settings.exportLog"))+" ",1),A("span",Yjt,P(p(n)("settings.exportLogHint")),1),p(Xu)()?te("",!0):(b(),E("span",Jjt,P(p(n)("settings.logHint")),1))]),Z(p(Sn),{variant:"secondary",size:"sm",onClick:q},{default:re(()=>[qe(P(p(n)("settings.exportLogBtn")),1)]),_:1})])])]),', ''],
  ['A("section",Xjt,[A("h3",eHt,P(p(n)("settings.agreements")),1),A("div",tHt,[A("div",nHt,[A("span",iHt,P(p(n)("settings.userAgreement")),1),Z(p(tn),{size:"sm",label:p(n)("settings.userAgreement"),tooltip:p(n)("settings.userAgreement"),onClick:Ee[13]||(Ee[13]=$e=>B(EHt))},{default:re(()=>[Z(p(Ce),{name:"external-link",size:"md"})]),_:1},8,["label","tooltip"])]),A("div",oHt,[A("span",sHt,P(p(n)("settings.privacyPolicy")),1),Z(p(tn),{size:"sm",label:p(n)("settings.privacyPolicy"),tooltip:p(n)("settings.privacyPolicy"),onClick:Ee[14]||(Ee[14]=$e=>B(LHt))},{default:re(()=>[Z(p(Ce),{name:"external-link",size:"md"})]),_:1},8,["label","tooltip"])])])])', ''],
  // product version identity (About page App version line only)
  [
    'const Ae="2.0.2".trim()?"2.0.2":""',
    `const Ae="${PRODUCT_VERSION}".trim()?"${PRODUCT_VERSION}":""`,
  ],
  ['2026-09-23T12:02:26.699Z', '2026-10-13T00:00:00.000Z'],
];

// Structural removals on the minified bundle (regex applied to .js files).
// Drop the whole managed "Kimi Subscription" group (heading + rows) from the
// Model Providers settings page; the API-providers group right after it stays.

const CSS_REPLACEMENTS = [
  ['--logo: #1783ff', '--logo: #2777B8'],
  ['--logo: #1a88ff', '--logo: #71BDF0'],
  // Brand accent: accessible mint/blue values derived from the canonical logo.
  ['--color-accent: #1783ff', '--color-accent: #2777B8'],
  ['--color-accent: #1a88ff', '--color-accent: #71BDF0'],
  ['--color-accent-hover: #258eff', '--color-accent-hover: #1E6198'],
  ['--color-accent-soft: rgba(26, 136, 255, .1)', '--color-accent-soft: rgba(39, 119, 184, .12)'],
  ['--color-accent-soft: #e8f3ff', '--color-accent-soft: #E2F3F1'],
  ['--color-accent-bd: rgba(26, 136, 255, .28)', '--color-accent-bd: rgba(39, 119, 184, .32)'],
  ['--blue: #1a88ff', '--blue: #2777B8'],
  ['--markdown-link-color: light-dark(#0f6ef2, #3393ff)', '--markdown-link-color: light-dark(#2777B8, #71BDF0)'],
];

const FONT =
  'Cormorant Garamond Variable,Noto Serif SC Variable,Songti SC,STSong,Georgia,serif';

for (const [label, filePath] of [
  ['canonical mark', MARK],
  ['favicon', FAVICON],
  ['theme source', THEME],
]) {
  if (!existsSync(filePath)) throw new Error(`OpenAqua ${label} not found at ${filePath}`);
}
const markDataUri = `data:image/png;base64,${readFileSync(MARK).toString('base64')}`;

const REGEX_REPLACEMENTS = [
  {
    pattern:
      /A\("h4",[\w$]+,P\(p\(i\)\("providers\.groupManaged"\)\),1\),A\("div",[\w$]+,\[[\s\S]*?(?=A\("h4",[\w$]+,P\(p\(i\)\("providers\.groupCustom"\)\))/,
    replace: '',
  },
];

// Keep the upstream Kimi "K" icon for Kimi providers. Product-level marks
// (sidebar, empty state, and loading screen) remain branded as OpenAqua.

function gradientBadge(id, rect, ellipse, bar, scope) {
  return [
    `<defs ${scope}><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1" ${scope}>`,
    `<stop offset="0" stop-color="#63CAF7" ${scope}></stop>`,
    `<stop offset="1" stop-color="#558BF4" ${scope}></stop></linearGradient></defs>`,
    `<rect ${rect} fill="url(#${id})" ${scope}></rect>`,
    `<ellipse ${ellipse} fill="none" stroke="#fff" ${scope}></ellipse>`,
    `<rect ${bar} fill="#fff" ${scope}></rect>`,
  ].join('');
}

function markImage(x, y, size, scope, fallback) {
  if (markDataUri !== undefined) {
    return `<image href="${markDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" ${scope}></image>`;
  }
  return fallback;
}

// Hero wordmark (empty-session view): canonical mark, product name, and domain line.
const HERO_INNER =
  markImage(
    3,
    3,
    58,
    'data-v-77dd99b8',
    gradientBadge(
      'tbHeroG',
      'x="3" y="4" width="56" height="56" rx="13"',
      'cx="31" cy="32" rx="14" ry="14" stroke-width="4.8"',
      'x="19.5" y="29.6" width="23" height="4.8" rx="2.4"',
      'data-v-77dd99b8',
    ),
  ) +
  `<text class="tb-wordmark-title" x="72" y="48" font-family="${FONT}" font-size="41" font-weight="700" letter-spacing="-0.35" fill="currentColor" data-v-77dd99b8>OpenAqua</text>` +
  '<text class="tb-wordmark-subtitle" x="74" y="70" font-size="9" font-weight="650" letter-spacing="1.25" fill="currentColor" data-v-77dd99b8>WATER-TREATMENT RESEARCH WORKBENCH</text>';

// Sidebar logo, viewBox 0 0 32 22: logo mark.
const SIDE_INNER = markImage(
  6,
  1,
  20,
  'data-v-71425e11',
  gradientBadge(
    'tbSideG',
    'x="1" y="1" width="30" height="20" rx="6"',
    'cx="16" cy="11" rx="7.2" ry="6.4" stroke-width="2.4"',
    'x="10" y="9.9" width="12" height="2.2" rx="1.1"',
    'data-v-71425e11',
  ),
);

// Connecting splash logo (GlobalLoading), viewBox 0 0 96 32: centered mark.
const GLOAD_INNER =
  `<svg class="gload-logo" viewBox="0 0 96 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" data-v-f0064e51>` +
  markImage(
    33,
    1,
    30,
    'data-v-f0064e51',
    gradientBadge(
      'tbLoadG',
      'x="33" y="1" width="30" height="30" rx="8"',
      'cx="48" cy="16" rx="8" ry="8" stroke-width="2.8"',
      'x="41.5" y="14.9" width="13" height="2.4" rx="1.2"',
      'data-v-f0064e51',
    ),
  ) +
  '</svg>';

const SVG_REPLACEMENTS = [
  { anchor: 'class:"wordmark"', inner: HERO_INNER },
  { anchor: 'class:"ch-logo"', inner: SIDE_INNER },
  { anchor: 'class:"gload",role:"status"', inner: GLOAD_INNER },
];

if (!existsSync(path.join(SRC, 'index.html'))) {
  console.error(`web UI bundle not found at ${SRC}`);
  process.exit(1);
}

rmSync(DST, { recursive: true, force: true });
cpSync(SRC, DST, { recursive: true });

function installThemeAssets() {
  if (!existsSync(THEME)) {
    throw new Error(`OpenAqua theme source not found at ${THEME}`);
  }

  const destinationRoot = path.join(DST, 'assets', FONT_ASSET_DIR);
  mkdirSync(destinationRoot, { recursive: true });
  const fontCss = [];

  for (const fontPackage of FONT_PACKAGES) {
    const sourceRoot = path.join(productRoot, 'node_modules', ...fontPackage.name.split('/'));
    if (!existsSync(sourceRoot)) {
      throw new Error(
        `Theme font package ${fontPackage.name} is missing. Run npm install at ${productRoot}.`,
      );
    }

    const destination = path.join(destinationRoot, fontPackage.slug);
    cpSync(path.join(sourceRoot, 'files'), destination, { recursive: true });
    copyFileSync(
      path.join(sourceRoot, 'LICENSE'),
      path.join(destinationRoot, `LICENSE-${fontPackage.slug}.txt`),
    );

    for (const stylesheet of fontPackage.styles) {
      fontCss.push(
        readFileSync(path.join(sourceRoot, stylesheet), 'utf8').replaceAll(
          './files/',
          `./${FONT_ASSET_DIR}/${fontPackage.slug}/`,
        ),
      );
    }
  }

  return `${fontCss.join('\n')}\n${readFileSync(THEME, 'utf8')}`;
}

const CSS_APPEND = installThemeAssets();

let patchedFiles = 0;
let patchedStrings = 0;
let themedStylesheets = 0;
const svgReplacementCounts = new Map(SVG_REPLACEMENTS.map(({ anchor }) => [anchor, 0]));

function patchText(filePath, replacements) {
  const original = readFileSync(filePath, 'utf8');
  let text = original;
  for (const [from, to] of replacements) {
    const count = text.split(from).length - 1;
    if (count > 0) {
      text = text.split(from).join(to);
      patchedStrings += count;
    }
  }
  if (text !== original) {
    writeFileSync(filePath, text);
    patchedFiles += 1;
  }
}

function patchRegex(filePath, replacements) {
  const original = readFileSync(filePath, 'utf8');
  let text = original;
  for (const { pattern, replace } of replacements) {
    const next = text.replace(pattern, () => {
      patchedStrings += 1;
      return replace;
    });
    text = next;
  }
  if (text !== original) {
    writeFileSync(filePath, text);
    patchedFiles += 1;
  }
}

// Replace the inner markup of the first ih('...') static-html call following an
// anchor (a class:"..." attribute of the target svg component).
function replaceSvgInner(filePath, anchor, newInner) {
  const text = readFileSync(filePath, 'utf8');
  const anchorIdx = text.indexOf(anchor);
  if (anchorIdx < 0) return false;
  const start = text.indexOf("ih('", anchorIdx);
  if (start < 0) return false;
  const contentStart = start + 4;
  let end = contentStart;
  for (;;) {
    const q = text.indexOf("'", end);
    if (q < 0) return false;
    if (text[q - 1] !== '\\') {
      end = q;
      break;
    }
    end = q + 1;
  }
  writeFileSync(filePath, text.slice(0, contentStart) + newInner + text.slice(end));
  return true;
}

patchText(path.join(DST, 'index.html'), TEXT_REPLACEMENTS);
patchText(path.join(DST, 'boot.js'), TEXT_REPLACEMENTS);
for (const entry of readdirSync(path.join(DST, 'assets'))) {
  const filePath = path.join(DST, 'assets', entry);
  if (/\.(js|html|svg)$/.test(entry)) {
    patchText(filePath, TEXT_REPLACEMENTS);
  }
  if (/\.js$/.test(entry)) {
    patchRegex(filePath, REGEX_REPLACEMENTS);
  }
  if (/\.css$/.test(entry)) {
    patchText(filePath, CSS_REPLACEMENTS);
    const css = readFileSync(filePath, 'utf8');
    if (css.includes('--color-accent') && !css.includes('OpenAqua visual system')) {
      writeFileSync(filePath, `${css}\n${CSS_APPEND}`);
      patchedFiles += 1;
      themedStylesheets += 1;
    }
  }
  if (/\.js$/.test(entry)) {
    for (const { anchor, inner } of SVG_REPLACEMENTS) {
      if (replaceSvgInner(filePath, anchor, inner)) {
        patchedStrings += 1;
        svgReplacementCounts.set(anchor, (svgReplacementCounts.get(anchor) ?? 0) + 1);
      }
    }
  }
}

if (existsSync(FAVICON)) {
  copyFileSync(FAVICON, path.join(DST, 'favicon.ico'));
  console.log('web-ui: favicon.ico replaced with OpenAqua icon');
}
if (markDataUri !== undefined) {
  copyFileSync(MARK, path.join(DST, 'openaqua-logo.png'));
  console.log('web-ui: canonical brand mark embedded and copied from build/logo-256.png');
}
console.log(`web-ui: bundled ${FONT_PACKAGES.length} self-hosted theme font families`);

// Cache-bust: the server sends /assets with `immutable, max-age=1y` while our
// patches keep the original hash filenames, so stamp a content-version query
// onto every asset URL in index.html to force revalidation after each sync.
{
  const indexPath = path.join(DST, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  const hash = createHash('sha1');
  for (const entry of readdirSync(path.join(DST, 'assets'))) {
    if (/^index-.*\.(js|css)$/.test(entry)) {
      hash.update(readFileSync(path.join(DST, 'assets', entry)));
    }
  }
  const stamp = hash.digest('hex').slice(0, 8);
  const before = html;
  html = html.replace(/(src|href)="(\/(?:boot\.js|assets\/[^"]+))"/g, (_m, attr, url) => {
    const sep = url.includes('?') ? '&' : '?';
    return `${attr}="${url}${sep}v=${stamp}"`;
  });
  if (html !== before) {
    writeFileSync(indexPath, html);
    console.log(`web-ui: cache-bust stamp v=${stamp} applied to index.html asset URLs`);
  }
}

assertBrandContract();

console.log(`web-ui: copied ${SRC} -> ${DST}`);
console.log(`web-ui: patched ${patchedStrings} strings in ${patchedFiles} files`);
console.log(`web-ui: branding contract verified for OpenAqua Harness ${PRODUCT_VERSION}`);

function assertBrandContract() {
  const indexHtml = readFileSync(path.join(DST, 'index.html'), 'utf8');
  if (!indexHtml.includes('<title>OpenAqua Harness</title>')) {
    throw new Error('Branding contract failed: product title was not applied');
  }
  for (const expectedThemeColor of ['#f3fbfa', '#0d2632']) {
    if (!indexHtml.includes(`content="${expectedThemeColor}"`)) {
      throw new Error(
        `Branding contract failed: theme color ${expectedThemeColor} was not applied`,
      );
    }
  }
  if (themedStylesheets < 1) {
    throw new Error('Branding contract failed: OpenAqua theme was not appended');
  }
  const stylesheets = readdirSync(path.join(DST, 'assets'))
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => readFileSync(path.join(DST, 'assets', entry), 'utf8'))
    .join('\n');
  for (const token of [
    '--tb-paper: #f3fbfa',
    '--tb-teal: #239f83',
    '--tb-sidebar: #e7f7f3',
    '--tb-paper: #0d2632',
    '--tb-sidebar: #0e3542',
  ]) {
    if (!stylesheets.includes(token)) {
      throw new Error(`Branding contract failed: bright palette token ${token} is missing`);
    }
  }
  for (const [anchor, count] of svgReplacementCounts) {
    if (count !== 1) {
      throw new Error(
        `Branding contract failed: expected one SVG replacement for ${anchor}, found ${String(count)}`,
      );
    }
  }
  if (markDataUri !== undefined) {
    const copiedMark = path.join(DST, 'openaqua-logo.png');
    if (!existsSync(copiedMark) || sha256(copiedMark) !== sha256(MARK)) {
      throw new Error('Branding contract failed: copied logo differs from the canonical mark');
    }
  }
  const expectedVersion = `const Ae="${PRODUCT_VERSION}".trim()?"${PRODUCT_VERSION}":""`;
  const javascript = readdirSync(path.join(DST, 'assets'))
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => readFileSync(path.join(DST, 'assets', entry), 'utf8'))
    .join('\n');
  if (!javascript.includes(expectedVersion)) {
    throw new Error('Branding contract failed: About-page version was not synchronized');
  }
  if (
    !javascript.includes(
      'function vZe(){const e=kM(Ese);return e&&Mse.includes(e)?e:"light"}',
    ) ||
    !javascript.includes('const Cw={light:"#f3fbfa",dark:"#0d2632"}')
  ) {
    throw new Error('Branding contract failed: bright default color scheme was not applied');
  }
  const kimiProviderIconCount = javascript.split('<title>Kimi</title>').length - 1;
  if (kimiProviderIconCount !== 1 || javascript.includes('<title>OpenAqua</title>')) {
    throw new Error('Branding contract failed: Kimi provider icon was not preserved');
  }
  const providerSetupHandler = 'function a(){c()}function l(){Vy.value=!0}';
  if (javascript.split(providerSetupHandler).length - 1 !== 1) {
    throw new Error('Branding contract failed: model setup does not open Provider settings');
  }
  if (
    javascript.includes('Sign in to OpenAqua Harness') ||
    javascript.includes('OpenAqua Harness login') ||
    javascript.includes('登录 OpenAqua Harness')
  ) {
    throw new Error('Branding contract failed: upstream OAuth dialog is still OpenAqua-branded');
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
