// ══════════════════════════════════════════════════════════════════
//  main.js — Proceso principal de Electron (optimizado)
//  FIXES v24.1:
//  - PowerShell lanzado con -Command + UTF-8 forzado (fix encoding PS1)
//  - stopScript() usa execSync para matar proceso antes de continuar
//  - rendererPath simplificado (código muerto eliminado)
// ══════════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { spawn, execSync, execFileSync } = require('child_process');
const license = require('./lib/license');

const TRIAL_MS = 30 * 60 * 1000;
const REG_BASE = 'HKCU\\Software\\OfertivaMX\\InternetSOSplay';
const TRIAL_MIN_EPOCH_MS = Date.UTC(2024, 0, 1);

// Caché de Chromium bajo userData evita en muchos equipos los errores
// "Unable to move the cache / Acceso denegado" al lanzar desde CMD o con AV.
try {
  app.setPath('cache', path.join(app.getPath('userData'), 'chromium-cache'));
} catch (_) { /* ok */ }

// En algunos equipos/VMs/drivers, Electron puede spamear:
// "ContextResult::kTransientFailure: Failed to send GpuControl..."
// Esto no afecta al keepalive, pero ensucia la consola. Desactivar GPU lo evita.
try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} catch (_) { /* ok */ }

// ── OPTIMIZACIONES PARA PCs DE BAJOS RECURSOS ────────────────────
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-smooth-scrolling');

// ── RUTAS ────────────────────────────────────────────────────────
const isDev      = !app.isPackaged;
const scriptsDir = isDev
  ? path.join(__dirname, 'scripts')
  : path.join(process.resourcesPath, 'scripts');

const configDir      = app.getPath('userData');
const configPath     = path.join(configDir, 'portal_config.json');
const appearancePath = path.join(configDir, 'appearance_config.json');
const licensePath    = path.join(configDir, 'license.json');

let mainWindow = null;
let psProcess  = null;
let licenseStatusTimer = null;

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'www.facebook.com',
  'facebook.com',
  't.me',
  'telegram.me',
  'github.com',
  'www.github.com'
]);

function isAllowedExternalUrl(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return ALLOWED_EXTERNAL_HOSTS.has(u.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function regReadValue(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', REG_BASE, '/v', name],
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const lines = String(out || '').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.+)\\s*$`));
      if (m) return m[1].trim();
    }
  } catch (_) { /* sin clave */ }
  return null;
}

function regWriteValue(name, data) {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync(
      'reg.exe',
      ['add', REG_BASE, '/v', name, '/t', 'REG_SZ', '/d', String(data), '/f'],
      { windowsHide: true, stdio: 'ignore' }
    );
    return true;
  } catch (_) {
    return false;
  }
}

function trialFilePath() {
  return path.join(configDir, 'trial_state.json');
}

function persistentTrialDir() {
  if (process.platform !== 'win32') return configDir;
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  return path.join(pd, 'OfertivaMX', 'InternetSOSplay');
}

function persistentTrialFilePath() {
  return path.join(persistentTrialDir(), 'trial_state.json');
}

function readTrialFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeTrialFile(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) { /* ok */ }
}

function parseEpochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < TRIAL_MIN_EPOCH_MS || n > Date.now() + (365 * 24 * 60 * 60 * 1000)) return null;
  return n;
}

function collectTrialEpochCandidates() {
  const candidates = [];
  const fromReg = parseEpochMs(regReadValue('TrialEpochMs'));
  if (fromReg != null) candidates.push(fromReg);
  const fromRegBackup = parseEpochMs(regReadValue('TrialEpochMsBackup'));
  if (fromRegBackup != null) candidates.push(fromRegBackup);

  const userFile = readTrialFile(trialFilePath());
  const fromUserFile = userFile && parseEpochMs(userFile.trialEpochMs);
  if (fromUserFile != null) candidates.push(fromUserFile);

  const persistentFile = readTrialFile(persistentTrialFilePath());
  const fromPersistentFile = persistentFile && parseEpochMs(persistentFile.trialEpochMs);
  if (fromPersistentFile != null) candidates.push(fromPersistentFile);

  return candidates;
}

function persistTrialEpoch(ms) {
  const value = String(ms);
  const payload = { trialEpochMs: ms, updatedAt: new Date().toISOString() };
  regWriteValue('TrialEpochMs', value);
  regWriteValue('TrialEpochMsBackup', value);
  writeTrialFile(trialFilePath(), payload);
  writeTrialFile(persistentTrialFilePath(), payload);
}

function getTrialStartMs() {
  const candidates = collectTrialEpochCandidates();
  if (candidates.length > 0) {
    const oldest = Math.min(...candidates);
    // Autorreparar todas las copias con la marca mas antigua valida.
    persistTrialEpoch(oldest);
    return oldest;
  }

  const started = Date.now();
  persistTrialEpoch(started);
  return started;
}

function computeLicenseGate() {
  let deviceId = '';
  try {
    deviceId = license.getDeviceId();
  } catch (e) {
    return {
      licensed: false,
      needsLicense: true,
      deviceId: '',
      error: e.message || 'No se pudo leer ID de equipo',
      trialActive: false,
      trialExpired: true,
      trialSecondsLeft: 0,
      trialTotalSeconds: Math.floor(TRIAL_MS / 1000),
      isPackaged: true
    };
  }

  const lic = license.isLicenseValid(configDir);
  if (lic.valid) {
    return {
      licensed: true,
      needsLicense: false,
      deviceId: lic.deviceId || deviceId,
      error: null,
      trialActive: false,
      trialExpired: false,
      trialSecondsLeft: 0,
      trialTotalSeconds: Math.floor(TRIAL_MS / 1000),
      isPackaged: true
    };
  }

  const start = getTrialStartMs();
  const elapsed = Date.now() - start;
  const leftMs = Math.max(0, TRIAL_MS - elapsed);
  const trialActive = leftMs > 0;

  return {
    licensed: false,
    needsLicense: !trialActive,
    deviceId,
    error: trialActive ? null : 'Prueba finalizada — activa tu licencia',
    trialActive,
    trialExpired: !trialActive,
    trialSecondsLeft: Math.floor(leftMs / 1000),
    trialTotalSeconds: Math.floor(TRIAL_MS / 1000),
    isPackaged: true
  };
}

function pushLicenseStatus() {
  if (!app.isPackaged) return;
  const st = computeLicenseGate();
  if (st.needsLicense && psProcess) {
    stopScript();
  }
  sendToRenderer('license-status', { ok: true, ...st });
}

function ensureLicenseStatusTicker() {
  if (!app.isPackaged || licenseStatusTimer) return;
  licenseStatusTimer = setInterval(() => {
    pushLicenseStatus();
  }, 15000);
}

// ── CREAR VENTANA ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1150,
    height:    820,
    minWidth:  900,
    minHeight: 700,
    frame:     false,
    backgroundColor: '#0e0f11',
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      sandbox:              false,
      backgroundThrottling: false,
      spellcheck:           false,
      webgl:                false
    },
    show: false
  });

  // FIX: ambas ramas del ternario original eran idénticas — simplificado
  const rendererPath = path.join(__dirname, 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);

  // Abrir links externos en navegador del sistema (no dentro de la app)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    stopScript();
    mainWindow = null;
  });
}

// ── GESTIÓN DEL SCRIPT ───────────────────────────────────────────

function startScript() {
  if (psProcess) stopScript();

  const scriptPath = path.join(scriptsDir, 'keepalive.ps1');
  if (!fs.existsSync(scriptPath)) {
    sendToRenderer('ps-error', `Script no encontrado: ${scriptPath}`);
    return;
  }

  // FIX ENCODING: usar -Command en lugar de -File.
  // Con -File, PowerShell inicializa la consola ANTES de que podamos
  // fijar el encoding, corrompiendo tildes/ñ en strings del script.
  // Con -Command podemos forzar UTF-8 como primer statement.
  const scriptEsc = scriptPath.replace(/'/g, "''");
  const configEsc = configPath.replace(/'/g, "''");
  const psCommand =
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
    `[Console]::InputEncoding  = [System.Text.Encoding]::UTF8; ` +
    `& '${scriptEsc}' -ConfigPath '${configEsc}'`;

  psProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'RemoteSigned',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat', 'Text',
    '-Command', psCommand
  ], {
    stdio:       ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env:         { ...process.env }
  });

  sendToRenderer('ps-started', { pid: psProcess.pid });

  // Leer stdout del PS1 — cada línea es un JSON
  let buf = '';
  psProcess.stdout.on('data', (data) => {
    buf += data.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop(); // guardar línea incompleta

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        sendToRenderer('ps-data', JSON.parse(t));
      } catch {
        sendToRenderer('ps-log', t);
      }
    }
  });

  // stderr del PS1 → errores de sintaxis o excepciones no capturadas
  let errBuf = '';
  psProcess.stderr.on('data', (data) => {
    errBuf += data.toString('utf8');
    const lines = errBuf.split('\n');
    errBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t) sendToRenderer('ps-error', t);
    }
  });

  psProcess.on('close', (code) => {
    if (errBuf.trim()) sendToRenderer('ps-error', errBuf.trim());
    psProcess = null;
    sendToRenderer('ps-stopped', { code });
  });

  psProcess.on('error', (err) => {
    psProcess = null;
    sendToRenderer('ps-error', `No se pudo iniciar PowerShell: ${err.message}`);
  });
}

// FIX: stopScript usa execSync — mata el árbol de procesos de forma
// síncrona, garantizando que el PS1 viejo haya muerto antes de que
// startScript lance uno nuevo. Elimina el bug de doble instancia.
function stopScript() {
  if (!psProcess) return;
  const pid = psProcess.pid;
  psProcess = null;
  try {
    execSync(`taskkill /pid ${pid} /f /t`, { windowsHide: true, stdio: 'ignore' });
  } catch (_) { /* proceso ya terminado — ok */ }
}

// ── HELPERS ──────────────────────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function getGithubPublishTarget() {
  const pkg = readPackageJson();
  const pub = pkg && pkg.build && pkg.build.publish;
  const first = Array.isArray(pub) ? pub[0] : pub;
  if (!first || first.provider !== 'github' || !first.owner || !first.repo) return null;
  return { owner: first.owner, repo: first.repo };
}

function tagToSemver(tag) {
  return String(tag || '').replace(/^v/i, '').trim();
}

function semverTuple(v) {
  const s = tagToSemver(v);
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function semverCompare(a, b) {
  const A = semverTuple(a);
  const B = semverTuple(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] - B[i];
  }
  return 0;
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'InternetSOSplay-updater',
          Accept: 'application/vnd.github+json'
        }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 240)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
  });
}

// ── IPC ──────────────────────────────────────────────────────────

ipcMain.handle('start-script', () => {
  if (app.isPackaged) {
    const st = computeLicenseGate();
    if (st.needsLicense) {
      return { ok: false, blocked: true, error: 'Licencia requerida para iniciar' };
    }
  }
  startScript();
  return { ok: true };
});
ipcMain.handle('stop-script',  ()         => { stopScript();  return { ok: true }; });
ipcMain.handle('is-running',   ()         => ({ running: psProcess !== null }));

ipcMain.handle('save-config', (_, config) => {
  try {
    ensureConfigDir();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-config', () => {
  try {
    if (fs.existsSync(configPath))
      return { ok: true, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    return { ok: true, config: null };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-appearance', (_, appearance) => {
  try {
    ensureConfigDir();
    fs.writeFileSync(appearancePath, JSON.stringify(appearance, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-appearance', () => {
  try {
    if (fs.existsSync(appearancePath))
      return { ok: true, appearance: JSON.parse(fs.readFileSync(appearancePath, 'utf8')) };
    return { ok: true, appearance: null };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-paths', () => ({
  config:   configPath,
  scripts:  scriptsDir,
  userData: configDir
}));
ipcMain.handle('open-external', (_, url) => {
  try {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: 'URL invalida' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-app-version', () => ({
  ok: true,
  version: app.getVersion(),
  isPackaged: app.isPackaged
}));

ipcMain.handle('list-app-releases', async () => {
  const target = getGithubPublishTarget();
  if (!target) {
    return { ok: false, error: 'GitHub publish no configurado en package.json (build.publish)' };
  }
  const currentVersion = app.getVersion();
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/releases?per_page=40`;
  try {
    const data = await httpsJson(url);
    if (!Array.isArray(data)) return { ok: false, error: 'Respuesta inesperada de GitHub' };
    const releases = data
      .filter((r) => r && !r.draft && r.tag_name)
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        publishedAt: r.published_at || '',
        url: r.html_url || ''
      }))
      .filter((r) => semverCompare(r.tag, currentVersion) > 0)
      .sort((a, b) => semverCompare(b.tag, a.tag));
    return { ok: true, currentVersion, count: releases.length, releases };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('download-app-update', async () => {
  if (!app.isPackaged) return { ok: false, skipped: true };
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.updateInfo) {
      return { ok: false, error: 'No hay actualizaciones compatibles para descargar' };
    }
    await autoUpdater.downloadUpdate();
    return { ok: true, version: r.updateInfo.version };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Controles de ventana
ipcMain.handle('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow && mainWindow.close());

// ── LICENCIA (solo build empaquetado) ───────────────────────────
ipcMain.handle('get-license-status', () => {
  if (!app.isPackaged) {
    let deviceId = 'dev';
    try { deviceId = license.getDeviceId(); } catch (_) { /* ok */ }
    return {
      ok: true,
      licensed: true,
      needsLicense: false,
      deviceId,
      isPackaged: false,
      trialActive: false,
      trialExpired: false,
      trialSecondsLeft: 0,
      trialTotalSeconds: Math.floor(TRIAL_MS / 1000),
      error: null
    };
  }
  const st = computeLicenseGate();
  return { ok: true, ...st };
});

ipcMain.handle('activate-license', (_, text) => {
  if (!app.isPackaged) return { ok: true };
  const pub = license.loadPublicKey();
  if (!pub) return { ok: false, error: 'Falta clave publica en la app' };
  let deviceId;
  try {
    deviceId = license.getDeviceId();
  } catch (e) {
    return { ok: false, error: e.message || 'ID de equipo' };
  }
  const parsed = license.parseLicenseText(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const v = license.verifyForDevice(deviceId, parsed.obj, pub);
  if (!v.ok) return { ok: false, error: v.error };
  try {
    ensureConfigDir();
    fs.writeFileSync(licensePath, JSON.stringify(parsed.obj, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  pushLicenseStatus();
  return { ok: true };
});

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      sendToRenderer('app-update', {
        kind: 'available',
        version: info && info.version,
        releaseDate: info && info.releaseDate
      });
    });
    autoUpdater.on('update-downloaded', () => {
      sendToRenderer('app-update', { kind: 'downloaded' });
    });
    autoUpdater.on('update-not-available', () => {
      sendToRenderer('app-update', { kind: 'none' });
    });
    autoUpdater.on('error', (err) => {
      sendToRenderer('app-update', { kind: 'error', error: err.message || String(err) });
    });
    autoUpdater.on('download-progress', (p) => {
      sendToRenderer('app-update', {
        kind: 'progress',
        percent: p.percent,
        transferred: p.transferred,
        total: p.total
      });
    });
  } catch (_) { /* sin electron-updater o feed no configurado */ }
}

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: true, skipped: true };
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    const r = await autoUpdater.checkForUpdates();
    return {
      ok: true,
      version: r && r.updateInfo && r.updateInfo.version,
      hasUpdate: !!(r && r.updateInfo)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('install-update-quit', () => {
  if (!app.isPackaged) return { ok: false };
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── LIFECYCLE ────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
  ensureLicenseStatusTicker();
  pushLicenseStatus();
});

app.on('window-all-closed', () => { stopScript(); app.quit(); });
app.on('before-quit',       () => { stopScript(); });
