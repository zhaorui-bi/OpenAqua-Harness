const { app, BrowserWindow, Menu, dialog, shell, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setName('openaqua-harness');

const PRODUCT = 'OpenAqua Harness';
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_STOP_GRACE_MS = 4_000;
const DESKTOP_SMOKE_TIMEOUT_MS = 120_000;
const MAX_ENGINE_BUFFER_BYTES = 64_000;
const DESKTOP_SMOKE = process.argv.includes('--smoke-test');
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g');
if (DESKTOP_SMOKE) app.disableHardwareAcceleration();
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const expectedServerExits = new WeakSet();

let mainWindow = null;
let serverProc = null;
let serverUrl = null;
let serverGeneration = 0;
let startupTimer = null;
let isQuitting = false;
let quitCleanupStarted = false;
let quitCleanupDone = false;
let currentWorkspace = app.getPath('home');
let serverQueue = Promise.resolve();
let loadingUrl = null;
let brandMarkDataUriCache = null;
let desktopSmokeTimer = null;
let desktopSmokeSettled = false;

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const workspaceDir = parsed.workspaceDir;
    if (typeof workspaceDir !== 'string' || !isDirectory(workspaceDir)) return {};
    return { workspaceDir: path.resolve(workspaceDir) };
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[openaqua] could not read settings:', error.message);
    }
    return {};
  }
}

function saveSettings(settings) {
  const parent = path.dirname(settingsPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(parent, 0o700);
  const temporary = path.join(
    parent,
    `.settings.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, settingsPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function aquaHomeDir() {
  const current = app.isPackaged
    ? path.join(app.getPath('userData'), 'openaqua-data')
    : path.join(__dirname, 'openaqua-data');
  if (!app.isPackaged) {
    const legacy = path.join(__dirname, 'kimi-data');
    if (!fs.existsSync(current) && fs.existsSync(legacy)) {
      let renamed = false;
      if (!treeContainsSymlink(legacy)) {
        try {
          fs.renameSync(legacy, current);
          renamed = true;
        } catch (error) {
          console.warn('[openaqua] legacy data rename failed; copying regular files:', error.message);
        }
      }
      if (!renamed) {
        const staging = `${current}.migration.${String(process.pid)}.${randomBytes(6).toString('hex')}`;
        try {
          copyRegularTree(legacy, staging);
          if (process.platform !== 'win32') restrictPrivateTree(staging);
          fs.renameSync(staging, current);
        } catch (error) {
          fs.rmSync(staging, { recursive: true, force: true });
          throw error;
        }
      } else if (process.platform !== 'win32') {
        restrictPrivateTree(current);
      }
      console.log('[openaqua] migrated kimi-data -> openaqua-data');
    }
  }
  fs.mkdirSync(current, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(current, 0o700);
    } catch (error) {
      console.warn('[openaqua] could not restrict data-directory permissions:', error.message);
    }
  }
  return current;
}

function treeContainsSymlink(source) {
  try {
    const metadata = fs.lstatSync(source);
    if (metadata.isSymbolicLink()) return true;
    if (!metadata.isDirectory()) return false;
    return fs.readdirSync(source).some((entry) =>
      treeContainsSymlink(path.join(source, entry)),
    );
  } catch {
    return true;
  }
}

function copyRegularTree(source, destination) {
  const metadata = fs.lstatSync(source);
  if (metadata.isSymbolicLink()) {
    console.warn('[openaqua] skipped symbolic link during legacy migration:', source);
    return;
  }
  if (metadata.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      copyRegularTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (metadata.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
  }
}

function restrictPrivateTree(target) {
  const metadata = fs.lstatSync(target);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) {
      restrictPrivateTree(path.join(target, entry));
    }
  } else if (metadata.isFile()) {
    fs.chmodSync(target, 0o600);
  }
}

function engineDir(...parts) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'harness')
    : path.join(__dirname, 'engine', 'apps', 'openaqua-harness');
  return path.join(base, ...parts);
}

function brandMarkDataUri() {
  if (brandMarkDataUriCache !== null) return brandMarkDataUriCache;
  const markPath = app.isPackaged
    ? path.join(process.resourcesPath, 'brand', 'logo.png')
    : path.join(__dirname, 'build', 'logo-256.png');
  try {
    brandMarkDataUriCache = `data:image/png;base64,${fs.readFileSync(markPath).toString('base64')}`;
  } catch (error) {
    console.warn('[openaqua] could not load brand mark:', error.message);
    brandMarkDataUriCache =
      'data:image/svg+xml;base64,' +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 5C24 17 15 27 15 40a17 17 0 0 0 34 0C49 27 40 17 32 5Z" fill="#239f83"/><path d="M32 5v52a17 17 0 0 0 17-17C49 27 40 17 32 5Z" fill="#2777b8"/></svg>').toString('base64');
  }
  return brandMarkDataUriCache;
}

function monorepoRoot() {
  return path.join(__dirname, 'engine');
}

function augmentedPath() {
  const entries = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(app.getPath('home'), '.local', 'bin'),
    ...(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
}

function importExistingConfig(homeDir) {
  if (fs.existsSync(path.join(homeDir, 'config.toml'))) return;
  const sourceHome = path.join(os.homedir(), '.openaqua');
  if (path.resolve(sourceHome) === path.resolve(homeDir)) return;
  if (!fs.existsSync(path.join(sourceHome, 'config.toml'))) return;

  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  for (const entry of ['config.toml', 'openaqua.json']) {
    const source = path.join(sourceHome, entry);
    const destination = path.join(homeDir, entry);
    if (isRegularFile(source) && !fs.existsSync(destination)) {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
    }
  }
  console.log('[openaqua] imported config from', sourceHome);
}

function queueServerStart(workspaceDir) {
  const generation = ++serverGeneration;
  currentWorkspace = path.resolve(workspaceDir);
  serverQueue = serverQueue
    .catch((error) => {
      console.error('[openaqua] previous server operation failed:', error);
    })
    .then(() => startServer(currentWorkspace, generation));
  return serverQueue;
}

async function startServer(cwd, generation) {
  if (generation !== serverGeneration || isQuitting) return;
  await stopServer();
  if (generation !== serverGeneration || isQuitting) return;

  if (!isUsableDirectory(cwd)) {
    handleServerFailure('工作目录不可用', `目录不存在、不可读或不可写：${cwd}`, generation);
    return;
  }

  serverUrl = null;
  showLoading(`正在启动水处理研究引擎…\n${cwd}`);

  let homeDir;
  try {
    homeDir = aquaHomeDir();
    if (!DESKTOP_SMOKE) importExistingConfig(homeDir);
  } catch (error) {
    handleServerFailure('无法初始化配置', error.message, generation);
    return;
  }

  const launch = resolveEngineLaunch(homeDir);
  if (launch.error) {
    handleServerFailure('缺少引擎', launch.error, generation);
    return;
  }

  console.log('[openaqua] starting web server, home =', homeDir, 'cwd =', cwd);
  const child = spawn(launch.command, launch.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: launch.env,
    detached: process.platform !== 'win32',
  });
  serverProc = child;

  let outputBuffer = '';
  let engineLogBuffer = '';
  const onData = (data) => {
    const text = data.toString();
    engineLogBuffer = writeCompleteEngineLogLines(engineLogBuffer + text);
    outputBuffer = `${outputBuffer}${stripAnsi(text)}`.slice(-MAX_ENGINE_BUFFER_BYTES);
    const match = outputBuffer.match(/Local:\s+(http:\/\/\S+)/);
    if (!match || serverUrl !== null || generation !== serverGeneration) return;
    const trustedUrl = validateLocalServerUrl(match[1]);
    if (trustedUrl === null) {
      handleServerFailure('引擎地址无效', '引擎返回了不受信任的本地服务地址。', generation);
      void stopServer();
      return;
    }
    serverUrl = trustedUrl;
    clearStartupTimer();
    console.log('[openaqua] server ready:', redactSecrets(serverUrl));
    void loadAppUrl(trustedUrl, generation);
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('error', (error) => {
    expectedServerExits.add(child);
    if (serverProc === child) serverProc = null;
    clearStartupTimer();
    handleServerFailure('无法启动 OpenAqua 引擎', error.message, generation);
  });
  child.once('exit', (code, signal) => {
    if (engineLogBuffer !== '') process.stdout.write(`[engine] ${redactSecrets(engineLogBuffer)}\n`);
    if (serverProc === child) serverProc = null;
    if (generation === serverGeneration) clearStartupTimer();
    if (isQuitting || expectedServerExits.has(child) || generation !== serverGeneration) return;
    const reason = signal ? `信号 ${signal}` : `退出码 ${String(code)}`;
    handleServerFailure('OpenAqua 引擎已退出', `Web 服务异常退出（${reason}）。`, generation);
  });

  startupTimer = setTimeout(() => {
    if (generation !== serverGeneration || serverUrl !== null) return;
    expectedServerExits.add(child);
    void stopServer();
    handleServerFailure(
      'OpenAqua 引擎启动超时',
      `在 ${String(SERVER_START_TIMEOUT_MS / 1000)} 秒内未检测到服务地址，请查看终端日志。`,
      generation,
    );
  }, SERVER_START_TIMEOUT_MS);
}

function resolveEngineLaunch(homeDir) {
  const distCli = engineDir('dist', 'cli.mjs');
  const baseEnv = {
    ...process.env,
    PATH: augmentedPath(),
    OPENAQUA_HOME: homeDir,
    ELECTRON_RUN_AS_NODE: '1',
  };

  if (fs.existsSync(distCli)) {
    if (app.isPackaged) {
      baseEnv.OPENAQUA_WEB_ASSETS_DIR = path.join(process.resourcesPath, 'web-ui');
    }
    return {
      command: process.execPath,
      args: [distCli, 'web', '--no-open', '--home', homeDir],
      env: baseEnv,
    };
  }

  const devCli = engineDir('src', 'cli.ts');
  const tsxCli = path.join(monorepoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!app.isPackaged && fs.existsSync(devCli) && fs.existsSync(tsxCli)) {
    return {
      command: process.execPath,
      args: [
        tsxCli,
        '--tsconfig',
        engineDir('tsconfig.dev.json'),
        '--import',
        path.join(monorepoRoot(), 'build', 'register-raw-text-loader.mjs'),
        devCli,
        'web',
        '--no-open',
        '--home',
        homeDir,
      ],
      env: baseEnv,
    };
  }

  return {
    error: '未找到 OpenAqua 引擎文件，请重新安装或运行 npm run setup。',
  };
}

async function stopServer() {
  clearStartupTimer();
  const child = serverProc;
  serverProc = null;
  serverUrl = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  expectedServerExits.add(child);
  await new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    let finalTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      resolve();
    };
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    if (!signalServerProcess(child, false)) {
      signalServerProcess(child, true);
    }
    forceTimer = setTimeout(() => {
      signalServerProcess(child, true);
    }, SERVER_STOP_GRACE_MS);
    finalTimer = setTimeout(finish, SERVER_STOP_GRACE_MS + 2_000);
  });
}

function signalServerProcess(child, force) {
  if (process.platform === 'win32' && child.pid) {
    const args = ['/pid', String(child.pid), '/t'];
    if (force) args.push('/f');
    if (spawnSync('taskkill', args, { stdio: 'ignore' }).status === 0) return true;
    if (!force) return false;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {}
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function clearStartupTimer() {
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function handleServerFailure(title, detail, generation) {
  if (generation !== serverGeneration || isQuitting) return;
  if (DESKTOP_SMOKE) {
    failDesktopSmoke(`${title}: ${detail}`);
    return;
  }
  showLoading(`引擎未运行\n${detail}`);
  dialog.showErrorBox(title, `${detail}\n\n可在“文件”菜单中重启引擎或选择其他工作目录。`);
}

async function verifyDesktopSmoke(url, generation) {
  if (!DESKTOP_SMOKE || desktopSmokeSettled || generation !== serverGeneration) return;
  try {
    const parsed = new URL(url);
    const token = decodeURIComponent(parsed.hash.slice('#token='.length));
    if (token === '') throw new Error('local server URL omitted its bearer token');
    if (mainWindow?.webContents.getTitle() !== PRODUCT) {
      throw new Error(`unexpected window title: ${String(mainWindow?.webContents.getTitle())}`);
    }
    const response = await fetch(`${parsed.origin}/api/v1/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'OpenAqua' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`search endpoint returned HTTP ${String(response.status)}`);
    const envelope = await response.json();
    if (envelope?.code !== 0) {
      throw new Error(`search endpoint returned code ${String(envelope?.code)}`);
    }
    const degraded = envelope?.data?.index_state?.degraded;
    if (typeof degraded === 'string' && degraded !== '') {
      throw new Error(`global search is degraded: ${degraded}`);
    }
    desktopSmokeSettled = true;
    clearTimeout(desktopSmokeTimer);
    process.stdout.write('DESKTOP_SMOKE_OK\n');
    app.quit();
  } catch (error) {
    failDesktopSmoke(error instanceof Error ? error.message : String(error));
  }
}

function failDesktopSmoke(message) {
  if (desktopSmokeSettled) return;
  desktopSmokeSettled = true;
  clearTimeout(desktopSmokeTimer);
  process.exitCode = 1;
  process.stderr.write(`DESKTOP_SMOKE_FAILED: ${message}\n`);
  app.quit();
}

function createMainWindow() {
  if (mainWindow) return mainWindow;
  const options = {
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1420' : '#f6f8fa',
    title: PRODUCT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      safeDialogs: true,
    },
  };
  if (!app.isPackaged) options.icon = path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow(options);
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      console.warn('[openaqua] denied renderer permission request:', permission);
      callback(false);
    },
  );
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit') return;
    handleServerFailure(
      'OpenAqua 界面进程已退出',
      `渲染进程异常退出（${details.reason}）。请从“文件”菜单重启引擎。`,
      serverGeneration,
    );
  });
  mainWindow.once('ready-to-show', () => {
    if (!DESKTOP_SMOKE) mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  attachContextMenu(mainWindow);
  attachNavigationGuards(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[openaqua] page loaded:', mainWindow?.webContents.getTitle());
  });
  return mainWindow;
}

function showLoading(message) {
  const win = createMainWindow();
  const lines = escapeHtml(message).replaceAll('\n', '<br>');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width">
  <meta name="color-scheme" content="light dark">
  <title>${PRODUCT}</title>
  <style>
    :root {
      --paper: #f6f8fa;
      --raised: #ffffff;
      --ink: #14243a;
      --muted: #52657a;
      --blue: #075fb5;
      --cyan: #0098d4;
      --line: rgba(7, 95, 181, .2);
      --grid: rgba(0, 112, 190, .028);
      --wash: rgba(0, 151, 212, .1);
      color-scheme: light dark;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: grid;
      place-items: center;
      overflow: hidden;
      background-color: var(--paper);
      background-image:
        radial-gradient(circle at 50% 38%, var(--wash), transparent 26rem),
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: auto, 32px 32px, 32px 32px;
      color: var(--ink);
      font-family: system-ui, -apple-system, "Noto Sans SC", "PingFang SC", sans-serif;
    }
    .frame {
      position: fixed;
      inset: 22px;
      border: 1px solid var(--line);
      pointer-events: none;
      opacity: .72;
    }
    .frame::before,
    .frame::after {
      content: "";
      position: absolute;
      width: 34px;
      height: 34px;
      border-color: var(--blue);
    }
    .frame::before {
      top: -1px;
      left: -1px;
      border-top: 1px solid;
      border-left: 1px solid;
    }
    .frame::after {
      right: -1px;
      bottom: -1px;
      border-right: 1px solid;
      border-bottom: 1px solid;
    }
    .card {
      width: min(680px, calc(100vw - 80px));
      padding: 42px;
      text-align: center;
      animation: reveal .5s cubic-bezier(.16, 1, .3, 1) both;
    }
    .eyebrow {
      margin-bottom: 24px;
      color: var(--blue);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .13em;
    }
    .mark {
      width: 78px;
      height: 78px;
      margin: 0 auto 25px;
      filter: drop-shadow(0 14px 22px color-mix(in srgb, var(--blue) 24%, transparent));
    }
    .mark img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .title {
      font-family: "Iowan Old Style", Baskerville, "Songti SC", STSong, Georgia, serif;
      font-size: clamp(30px, 4vw, 38px);
      font-weight: 500;
      letter-spacing: .01em;
      line-height: 1.1;
    }
    .rule {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      width: 170px;
      margin: 20px auto;
      color: var(--blue);
    }
    .rule::before,
    .rule::after {
      content: "";
      width: 68px;
      height: 1px;
      background: linear-gradient(90deg, transparent, currentColor);
    }
    .rule::after { transform: rotate(180deg); }
    .rule i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--cyan);
    }
    .detail {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.75;
      letter-spacing: .008em;
      word-break: break-all;
    }
    .pulse {
      display: flex;
      justify-content: center;
      gap: 6px;
      margin-top: 20px;
    }
    .pulse i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--blue);
      animation: breathe 1.5s ease-in-out infinite;
    }
    .pulse i:nth-child(2) { animation-delay: .18s; }
    .pulse i:nth-child(3) { animation-delay: .36s; }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes breathe {
      0%, 100% { opacity: .22; transform: scale(.8); }
      50% { opacity: 1; transform: scale(1); }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #0b1420;
        --raised: #152233;
        --ink: #e9f0f7;
        --muted: #a5b3c2;
        --blue: #66b8f2;
        --cyan: #4cc6e8;
        --line: rgba(102, 184, 242, .25);
        --grid: rgba(96, 180, 231, .027);
        --wash: rgba(0, 139, 219, .12);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card, .pulse i { animation: none; }
    }
  </style>
</head>
<body>
  <div class="frame" aria-hidden="true"></div>
  <main class="card">
    <div class="eyebrow">WATER TREATMENT · RESEARCH WORKBENCH</div>
    <div class="mark" aria-hidden="true"><img src="${brandMarkDataUri()}" alt=""></div>
    <div class="title">${PRODUCT}</div>
    <div class="rule" aria-hidden="true"><i></i></div>
    <div class="detail">${lines}</div>
    <div class="pulse" aria-hidden="true"><i></i><i></i><i></i></div>
  </main>
</body>
</html>`;
  loadingUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  void win.loadURL(loadingUrl).catch((error) => {
    // A fast server startup can supersede this temporary data URL before its
    // navigation commits. Chromium reports that expected hand-off as aborted.
    if (error && error.code === 'ERR_ABORTED') return;
    console.error('[openaqua] failed to show loading page:', error);
  });
}

async function loadAppUrl(url, generation) {
  const win = createMainWindow();
  try {
    await win.loadURL(url);
    if (generation === serverGeneration) loadingUrl = null;
    await verifyDesktopSmoke(url, generation);
  } catch (error) {
    handleServerFailure('无法加载 OpenAqua 界面', error.message, generation);
  }
}

function attachNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSameServerOrigin(url)) void openExternalUrl(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    if (url === loadingUrl || isSameServerOrigin(url)) return;
    event.preventDefault();
    void openExternalUrl(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
}

function isSameServerOrigin(candidate) {
  if (serverUrl === null) return false;
  try {
    return new URL(candidate).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

async function openExternalUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      console.warn('[openaqua] blocked external URL protocol:', url.protocol);
      return;
    }
    await shell.openExternal(url.href);
  } catch (error) {
    console.warn('[openaqua] could not open external URL:', error.message);
  }
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作目录',
    buttonLabel: '打开',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: currentWorkspace,
  });
  if (result.canceled || !result.filePaths[0]) return;
  const directory = path.resolve(result.filePaths[0]);
  try {
    saveSettings({ workspaceDir: directory });
  } catch (error) {
    dialog.showErrorBox('无法保存设置', error.message);
    return;
  }
  await queueServerStart(directory);
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: PRODUCT,
      submenu: [
        { role: 'about', label: `关于 ${PRODUCT}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${PRODUCT}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${PRODUCT}` },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: [
        { label: '打开工作目录…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace() },
        {
          label: '重启引擎',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => void queueServerStart(currentWorkspace),
        },
        { type: 'separator' },
        { role: 'reload', label: '刷新界面' },
        ...(!app.isPackaged || process.env.OPENAQUA_DEBUG === '1'
          ? [{ role: 'toggleDevTools', label: '开发者工具' }]
          : []),
        { type: 'separator' },
        { role: 'quit', label: `退出 ${PRODUCT}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.linkURL) {
      items.push({ label: '在浏览器中打开链接', click: () => void openExternalUrl(params.linkURL) });
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function validateLocalServerUrl(candidate) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
    if (
      url.protocol !== 'http:' ||
      !loopback ||
      !url.hash.startsWith('#token=') ||
      url.hash.length <= '#token='.length
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function writeCompleteEngineLogLines(text) {
  const lines = text.split('\n');
  const remainder = lines.pop() || '';
  for (const line of lines) process.stdout.write(`[engine] ${redactSecrets(line)}\n`);
  return remainder.slice(-MAX_ENGINE_BUFFER_BYTES);
}

function redactSecrets(text) {
  return text.replace(/(#token=)[^\s]+/g, '$1<redacted>');
}

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(filePath) {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isUsableDirectory(directory) {
  if (!isDirectory(directory)) return false;
  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = createMainWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    if (DESKTOP_SMOKE) {
      desktopSmokeTimer = setTimeout(() => {
        failDesktopSmoke(
          `desktop application did not become ready within ${String(DESKTOP_SMOKE_TIMEOUT_MS)}ms`,
        );
      }, DESKTOP_SMOKE_TIMEOUT_MS);
    }
    buildMenu();
    const settings = loadSettings();
    currentWorkspace = settings.workspaceDir || app.getPath('home');
    showLoading('正在初始化…');
    void queueServerStart(currentWorkspace);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      if (serverUrl !== null) {
        void loadAppUrl(serverUrl, serverGeneration);
      } else {
        showLoading('正在等待水处理研究引擎…');
      }
    });
  });

  app.on('before-quit', (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    isQuitting = true;
    serverGeneration++;
    void stopServer()
      .catch((error) => {
        console.warn('[openaqua] server cleanup failed during quit:', error.message);
      })
      .finally(() => {
        quitCleanupDone = true;
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
