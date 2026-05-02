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

  // Motor embebido: el PS1 real vive aqui como string.
  // Se escribe a %TEMP% con nombre aleatorio, se ejecuta y se borra con finally.
  // El scripts/keepalive.ps1 del repo es solo un stub de compatibilidad.
  const crypto  = require('crypto');
  const os      = require('os');
  const tmpName = 'isp_' + crypto.randomBytes(8).toString('hex') + '.ps1';
  const tmpPath = path.join(os.tmpdir(), tmpName);

  const PS1_SOURCE = "# ======================================================================\n#  Totalplay Club WiFi \u2014 Keep-alive (Electron Edition v31)\n#  Flujo IDENTICO al v23. JSON emitido con TODOS los campos siempre.\n# ======================================================================\n\nparam(\n    [string]$ConfigPath = \"\"\n)\n\n[System.Net.WebRequest]::DefaultWebProxy    = $null\n[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\n\n# \u2500\u2500 CONFIG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Load-Config {\n    param([string]$Path)\n    $c = [pscustomobject]@{\n        portalBase         = \"https://clubwifi.totalplay.com.mx\"\n        accname            = \"\"\n        wlanparameter      = \"\"\n        ssidPreferido      = \"\"\n        intervaloKeepAlive = 240\n        intervaloReintento = 1.0\n        segsParaReconWifi  = 45\n        segsParaResetNic   = 70\n        hotspotAlInicio    = $true\n    }\n    if ($Path -ne \"\" -and (Test-Path $Path)) {\n        try {\n            $j = Get-Content $Path -Raw | ConvertFrom-Json\n            if ($j.portalBase    -and $j.portalBase -ne \"\") { $c.portalBase         = $j.portalBase }\n            if ($j.accname)            { $c.accname            = $j.accname }\n            if ($j.wlanparameter)      { $c.wlanparameter      = $j.wlanparameter }\n            if ($j.ssidPreferido)      { $c.ssidPreferido      = $j.ssidPreferido }\n            if ($j.intervaloKeepAlive) { $c.intervaloKeepAlive = [int]$j.intervaloKeepAlive }\n            if ($j.intervaloReintento) { $c.intervaloReintento = [double]$j.intervaloReintento }\n            if ($j.segsParaReconWifi)  { $c.segsParaReconWifi  = [int]$j.segsParaReconWifi }\n            if ($j.segsParaResetNic)   { $c.segsParaResetNic   = [int]$j.segsParaResetNic }\n            if ($null -ne $j.hotspotAlInicio) { $c.hotspotAlInicio = [bool]$j.hotspotAlInicio }\n        } catch { }\n    }\n    return $c\n}\n\n$cfg               = Load-Config -Path $ConfigPath\n$portalBase        = $cfg.portalBase\n$validarUrl        = \"$portalBase/ClubMovil/validar-ip\"\n$accname           = $cfg.accname\n$wlanparameter     = $cfg.wlanparameter\n$ssidPreferido     = $cfg.ssidPreferido\n$intervaloKeepAlive = $cfg.intervaloKeepAlive\n$intervaloReintento = $cfg.intervaloReintento\n$segsParaReconWifi  = $cfg.segsParaReconWifi\n$segsParaResetNic   = $cfg.segsParaResetNic\n$hotspotAlInicio    = $cfg.hotspotAlInicio\n\n$configMtime = if ($ConfigPath -ne \"\" -and (Test-Path $ConfigPath)) {\n    (Get-Item $ConfigPath).LastWriteTime\n} else { [DateTime]::MinValue }\n\n# \u2500\u2500 SEND-EVENT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# IMPORTANTE: siempre emite TODOS los campos para que el renderer\n# los pueda leer aunque sean string vacio o 0.\nfunction Send-Event {\n    param(\n        [string]$type,\n        [string]$msg       = \"\",\n        [string]$ip        = \"\",\n        [string]$ssid      = \"\",\n        [string]$jsession  = \"\",\n        [int]$httpStatus   = 0,\n        [bool]$online      = $false,\n        [int]$restante     = 0,\n        [bool]$reconexion  = $false\n    )\n    $time   = Get-Date -Format \"HH:mm:ss\"\n    $msgEsc = $msg     -replace '\"', \"'\"\n    $sipEsc = $ip      -replace '\"', \"'\"\n    $sssEsc = $ssid    -replace '\"', \"'\"\n    $sjsEsc = $jsession -replace '\"', \"'\"\n\n    # JSON con TODOS los campos \u2014 el renderer siempre puede leerlos\n    $json = '{\"type\":\"'   + $type        + '\"' +\n            ',\"msg\":\"'    + $msgEsc      + '\"' +\n            ',\"time\":\"'   + $time        + '\"' +\n            ',\"ip\":\"'     + $sipEsc      + '\"' +\n            ',\"ssid\":\"'   + $sssEsc      + '\"' +\n            ',\"jsessionid\":\"' + $sjsEsc  + '\"' +\n            ',\"httpStatus\":'  + $httpStatus   +\n            ',\"online\":'      + ($online.ToString().ToLower()) +\n            ',\"restante\":'    + $restante   +\n            ',\"reconexion\":' + ($reconexion.ToString().ToLower()) +\n            '}'\n\n    Write-Output $json\n    [Console]::Out.Flush()\n}\n\n# \u2500\u2500 INTERNET \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n$testUrl = \"http://www.msftconnecttest.com/connecttest.txt\"\n$wc      = [System.Net.WebClient]::new()\n$wc.Proxy = $null\n\nfunction Hay-Internet {\n    try { return ($wc.DownloadString($testUrl) -match \"Microsoft Connect Test\") }\n    catch { return $false }\n}\n\n# \u2500\u2500 IP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Obtener-IP-Portal {\n    try {\n        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |\n               Where-Object { $_.IPAddress -match \"^10\\.\" } |\n               Select-Object -ExpandProperty IPAddress\n        return ($ips | Select-Object -First 1)\n    } catch { return $null }\n}\n\n# \u2500\u2500 SSID \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Get-SSIDActual {\n    try {\n        $info  = & netsh wlan show interfaces 2>$null\n        $linea = $info | Where-Object { $_ -match \"^\\s+SSID\\s+:\" } | Select-Object -First 1\n        if ($linea) { return ($linea -replace \"^\\s+SSID\\s+:\\s+\", \"\").Trim() }\n    } catch { }\n    return \"\"\n}\n\n# \u2500\u2500 AUTENTICAR \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Autenticar ($ip) {\n    $inicioUrl = \"$portalBase/ClubMovil/inicio?wlanuserip=$ip&wlanacname=&wlanparameter=$wlanparameter&accname=$accname&type=DESKTOP&webView=false\"\n\n    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession\n    $session.UserAgent = \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0\"\n\n    Invoke-WebRequest -UseBasicParsing -Uri $inicioUrl `\n        -WebSession $session `\n        -Headers @{\n            \"Accept\"          = \"text/html,application/xhtml+xml,*/*;q=0.8\"\n            \"Accept-Language\" = \"es-MX,es;q=0.9\"\n        } -TimeoutSec 10 | Out-Null\n\n    $jsessionid = $session.Cookies.GetCookies([uri]$portalBase) |\n                  Where-Object { $_.Name -eq \"JSESSIONID\" } |\n                  Select-Object -ExpandProperty Value -First 1\n\n    if (-not $jsessionid) { throw \"No se obtuvo JSESSIONID del portal\" }\n\n    $prev = $jsessionid.Substring(0, [math]::Min(12, $jsessionid.Length))\n    Send-Event -type \"gray\" -msg \"JSESSIONID: ${prev}...\" -jsession $prev\n\n    $body = \"{`\"ip`\":`\"$ip`\",`\"nombreAcc`\":`\"$accname`\",`\"mac`\":`\"$wlanparameter`\",`\"tipo`\":`\"DESKTOP`\"}\"\n\n    $r2 = Invoke-WebRequest -UseBasicParsing -Uri $validarUrl `\n        -Method POST -WebSession $session `\n        -Headers @{\n            \"Accept\"             = \"*/*\"\n            \"Accept-Language\"    = \"es-MX,es;q=0.9\"\n            \"Origin\"             = $portalBase\n            \"Referer\"            = $inicioUrl\n            \"Sec-Fetch-Dest\"     = \"empty\"\n            \"Sec-Fetch-Mode\"     = \"cors\"\n            \"Sec-Fetch-Site\"     = \"same-origin\"\n            \"sec-ch-ua\"          = '\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"'\n            \"sec-ch-ua-mobile\"   = \"?0\"\n            \"sec-ch-ua-platform\" = '\"Windows\"'\n        } `\n        -ContentType \"application/json\" -Body $body -TimeoutSec 10\n\n    return [int]$r2.StatusCode\n}\n\n# \u2500\u2500 REINICIAR ADAPTADOR \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Reset-Adaptador {\n    Send-Event -type \"warn\" -msg \"${segsParaResetNic}s sin internet -- reiniciando adaptador de red...\"\n    try {\n        $adapter = Get-NetAdapter | Where-Object {\n            $_.Status -eq \"Up\" -and $_.Name -notmatch \"Loopback|Virtual|Bluetooth\"\n        } | Select-Object -First 1\n        if ($adapter) {\n            Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop\n            Start-Sleep -Seconds 4\n            Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop\n            Start-Sleep -Seconds 6\n            Send-Event -type \"info\" -msg \"Adaptador reiniciado: $($adapter.Name)\"\n        } else {\n            Send-Event -type \"warn\" -msg \"No se encontro adaptador activo para reiniciar\"\n        }\n    } catch {\n        Send-Event -type \"warn\" -msg \"No se pudo reiniciar adaptador (requiere admin)\"\n    }\n}\n\nfunction Sleep-Reintento { param([double]$segundos) Start-Sleep -Milliseconds ([math]::Round([math]::Max(0.1, $segundos) * 1000)) }\n\n# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n#  INICIO\n# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\nSend-Event -type \"status\" -msg \"iniciado\" -ssid $ssidPreferido\nSend-Event -type \"info\"   -msg \"Keep-alive: ${intervaloKeepAlive}s | Reintento: ${intervaloReintento}s | WiFi@${segsParaReconWifi}s | NIC@${segsParaResetNic}s\"\n\nif ($hotspotAlInicio) {\n    & netsh wlan start hostednetwork 2>$null | Out-Null\n    Send-Event -type \"info\" -msg \"Hotspot activado al inicio\"\n}\n\n$ultimaRenovacion = [DateTime]::MinValue\n\n# $veniaDeCaida: true desde el primer ciclo sin internet hasta auth exitosa\n# Se limpia SOLO en el try-catch cuando auth es exitosa y fueCalda=true\n$veniaDeCaida = $false\n\n# Detectar transici\u00f3n offline -> online (conectividad) para contar reconexi\u00f3n\n# aunque el portal/auth tarde o falle (500/DNS/timeout).\n$internetPrev = $true\n\n# Escalada \u2014 adicionales al v23, no tocan el flujo original\n$inicioCaida     = $null   # DateTime del inicio de la caida actual\n$wifiReconectado = $false  # nivel 2 ya ejecutado en esta caida\n$nicReiniciada   = $false  # nivel 3 ya ejecutado en esta caida\n\n# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n#  BUCLE PRINCIPAL \u2014 estructura del v23\n# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\nwhile ($true) {\n\n    # \u2500\u2500 Recarga en caliente de config \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    if ($ConfigPath -ne \"\" -and (Test-Path $ConfigPath)) {\n        try {\n            $mtime = (Get-Item $ConfigPath).LastWriteTime\n            if ($mtime -ne $configMtime) {\n                $configMtime        = $mtime\n                $cfg                = Load-Config -Path $ConfigPath\n                $portalBase         = $cfg.portalBase\n                $validarUrl         = \"$portalBase/ClubMovil/validar-ip\"\n                $accname            = $cfg.accname\n                $wlanparameter      = $cfg.wlanparameter\n                $ssidPreferido      = $cfg.ssidPreferido\n                $intervaloKeepAlive = $cfg.intervaloKeepAlive\n                $intervaloReintento = $cfg.intervaloReintento\n                $segsParaReconWifi  = $cfg.segsParaReconWifi\n                $segsParaResetNic   = $cfg.segsParaResetNic\n                $hotspotAlInicio    = $cfg.hotspotAlInicio\n                Send-Event -type \"info\" -msg \"Config recargada: KA:${intervaloKeepAlive}s | RI:${intervaloReintento}s | WiFi@${segsParaReconWifi}s | NIC@${segsParaResetNic}s\"\n            }\n        } catch { }\n    }\n\n    $internet    = Hay-Internet\n    $segsDesde   = ([DateTime]::Now - $ultimaRenovacion).TotalSeconds\n    $debeRenovar = $segsDesde -ge $intervaloKeepAlive\n\n    # \u2500\u2500 Transici\u00f3n: internet volvi\u00f3 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    # Si ven\u00edamos de una ca\u00edda (veniaDeCaida/inicioCaida) y ahora hay internet,\n    # emitir evento de recuperaci\u00f3n ya (para contadores/AVG en UI).\n    if ((-not $internetPrev) -and $internet) {\n        if ($veniaDeCaida -or $inicioCaida) {\n            $ssidActual = Get-SSIDActual\n            $ssidToSend = if ($ssidActual) { $ssidActual } else { $ssidPreferido }\n            Send-Event -type \"ok\" `\n                -msg \"Internet restaurado -- re-autenticando...\" `\n                -online $true -reconexion $true `\n                -ssid $ssidToSend\n        }\n        # limpiar escalada al recuperar conectividad\n        $inicioCaida     = $null\n        $wifiReconectado = $false\n        $nicReiniciada   = $false\n    }\n    $internetPrev = $internet\n\n    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n    # CASO 1 \u2014 Online y NO toca renovar (v23: if $internet -and -not $debeRenovar)\n    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n    if ($internet -and -not $debeRenovar) {\n        $restante   = [int]($intervaloKeepAlive - $segsDesde)\n        $ssidActual = Get-SSIDActual\n        if ($veniaDeCaida) {\n            $veniaDeCaida = $false\n            Send-Event -type \"ok\" `\n                -msg \"Conexion restaurada -- proxima renovacion en ${restante}s\" `\n                -online $true -restante $restante -reconexion $true `\n                -ssid (if ($ssidActual) { $ssidActual } else { $ssidPreferido })\n            if ($hotspotAlInicio) {\n                Start-Sleep -Seconds 2\n                & netsh wlan start hostednetwork 2>$null | Out-Null\n                Send-Event -type \"info\" -msg \"Hotspot reactivado\"\n            }\n        } else {\n            Send-Event -type \"ok\" `\n                -msg \"Online -- proxima renovacion en ${restante}s\" `\n                -online $true -restante $restante `\n                -ssid (if ($ssidActual) { $ssidActual } else { $ssidPreferido })\n        }\n        Start-Sleep -Seconds ([math]::Min($restante, 30))\n        continue\n    }\n\n    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n    # CASO 2 \u2014 Sin internet (v23: if -not $internet)\n    # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n    if (-not $internet) {\n        # Primera vez: registrar inicio de caida y notificar\n        if (-not $inicioCaida) {\n            $inicioCaida  = [DateTime]::Now\n            $veniaDeCaida = $true\n            # v23: Write-Host \"[!] Sin internet...\"\n            Send-Event -type \"err\" -msg \"Sin internet -- re-autenticando...\"\n        }\n\n        $segsSinInternet = ([DateTime]::Now - $inicioCaida).TotalSeconds\n\n        # Nivel 3: reiniciar NIC \u2014 una sola vez por caida\n        if ((-not $nicReiniciada) -and ($segsSinInternet -ge $segsParaResetNic)) {\n            $nicReiniciada = $true\n            Reset-Adaptador\n            Sleep-Reintento -segundos $intervaloReintento\n            continue\n        }\n\n        # Nivel 2: reconectar WiFi \u2014 una sola vez, antes de la NIC\n        if ((-not $wifiReconectado) -and (-not $nicReiniciada) -and ($segsSinInternet -ge $segsParaReconWifi)) {\n            $wifiReconectado = $true\n            Send-Event -type \"warn\" -msg \"${segsParaReconWifi}s sin internet -- reconectando WiFi a '$ssidPreferido'...\"\n            if ($ssidPreferido -ne \"\") {\n                & netsh wlan connect name=\"$ssidPreferido\" 2>$null | Out-Null\n            }\n            Sleep-Reintento -segundos $intervaloReintento\n            continue\n        }\n\n    } else {\n        # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n        # CASO 3 \u2014 Hay que llamar al portal: renovacion preventiva o reintento\n        # tras fallo (DNS / portal); no spamear \"Renovando\" en cada ciclo de reintento.\n        # \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n        Send-Event -type \"info\" -msg \"Renovando sesion preventivamente...\"\n    }\n\n    # \u2500\u2500 Obtener IP (v23: $ip = Obtener-IP-Portal) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    $ip = Obtener-IP-Portal\n    if (-not $ip) {\n        # v23: Write-Host \"[\u2717] Sin IP \u2014 reconectando WiFi...\"\n        Send-Event -type \"warn\" -msg \"Sin IP 10.x -- reconectando WiFi a '$ssidPreferido'...\"\n        if ($ssidPreferido -ne \"\") {\n            & netsh wlan connect name=\"$ssidPreferido\" 2>$null | Out-Null\n        }\n        Sleep-Reintento -segundos $intervaloReintento\n        continue\n    }\n\n    # v23: Write-Host \"[i] IP: $ip\"  (gris, silencioso)\n    Send-Event -type \"gray\" -msg \"IP detectada: $ip\" -ip $ip\n\n    # \u2500\u2500 Autenticar (v23: try { $status = Autenticar $ip }) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    try {\n        $status     = Autenticar $ip\n        $ssidActual = Get-SSIDActual\n        $fueCalda   = $veniaDeCaida   # capturar ANTES de limpiar\n\n        # Exito: limpiar todo\n        $ultimaRenovacion = [DateTime]::Now\n        $inicioCaida      = $null\n        $wifiReconectado  = $false\n        $nicReiniciada    = $false\n\n        if ($fueCalda) {\n            # Venia de caida real \u2014 reconexion exitosa por auth\n            $veniaDeCaida = $false\n            # v23: Write-Host \"[\u2714] Autenticado...\" + \"[\ud83d\udce1] Activando hotspot...\"\n            Send-Event -type \"ok\" `\n                -msg \"Autenticado (reconexion) -- HTTP $status\" `\n                -online $true -httpStatus $status -ip $ip -reconexion $true `\n                -ssid (if ($ssidActual) { $ssidActual } else { $ssidPreferido })\n\n            if ($hotspotAlInicio) {\n                Start-Sleep -Seconds 2\n                & netsh wlan start hostednetwork 2>$null | Out-Null\n                Send-Event -type \"info\" -msg \"Hotspot reactivado\"\n            }\n        } else {\n            # Renovacion preventiva exitosa\n            # v23: Write-Host \"[\u2714] Autenticado...\"\n            Send-Event -type \"ok\" `\n                -msg \"Autenticado -- HTTP $status\" `\n                -online $true -httpStatus $status -ip $ip `\n                -ssid (if ($ssidActual) { $ssidActual } else { $ssidPreferido })\n        }\n\n    } catch {\n        $errMsg = $_.Exception.Message -replace '\"', \"'\"\n\n        # v23: Write-Host \"[\u2717] Error:...\" sleep; continue\n        # GUI: clasificar por $internet en ESTE ciclo, no por $veniaDeCaida.\n        # Motivo: tras una caida, si ya hay internet pero toca renovar (CASO 3),\n        # $veniaDeCaida puede seguir true hasta auth OK \u2014 entonces el log decia\n        # \"Renovando...\" y luego \"Error auth:\" como si fuera caida (incoherente).\n        if ($internet) {\n            Send-Event -type \"gray\" -msg \"Error auth (preventivo): $errMsg\"\n        } else {\n            Send-Event -type \"warn\" -msg \"Error auth: $errMsg\"\n        }\n\n        Sleep-Reintento -segundos $intervaloReintento\n        continue\n    }\n\n    # v23: Start-Sleep -Seconds 5\n    Start-Sleep -Seconds 5\n}\n";

  try {
    fs.writeFileSync(tmpPath, PS1_SOURCE, { encoding: 'utf8' });
  } catch (e) {
    sendToRenderer('ps-error', 'No se pudo escribir motor temporal: ' + e.message);
    return;
  }

  const tmpEsc    = tmpPath.replace(/'/g, "''");
  const configEsc = configPath.replace(/'/g, "''");
  const psCommand =
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
    `[Console]::InputEncoding  = [System.Text.Encoding]::UTF8; ` +
    `try { & '${tmpEsc}' -ConfigPath '${configEsc}' } finally { Remove-Item -LiteralPath '${tmpEsc}' -Force -ErrorAction SilentlyContinue }`;

  psProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
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
  // Hardcodeado para garantizar que siempre funcione aunque package.json
  // no este accesible en tiempo de ejecucion dentro del asar.
  return { owner: 'LewisNoN', repo: 'InternetSoSplay-app' };
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
