// ══════════════════════════════════════════════════════════════════
//  preload.js — Puente seguro entre el HTML (renderer) y Node.js (main)
//
//  CÓMO FUNCIONA:
//  - Electron separa el mundo de Node.js (main.js) del mundo del HTML
//  - Este archivo expone funciones seguras que el HTML puede llamar
//  - En el HTML usas: window.api.startScript(), window.api.saveConfig(), etc.
//  - contextBridge garantiza que el HTML NO puede acceder a Node.js directamente
// ══════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── CONTROL DEL SCRIPT PS1 ──────────────────────────────────────
  startScript:  () => ipcRenderer.invoke('start-script'),
  stopScript:   () => ipcRenderer.invoke('stop-script'),
  isRunning:    () => ipcRenderer.invoke('is-running'),

  // ── CONFIGURACIÓN ───────────────────────────────────────────────
  saveConfig:     (config) => ipcRenderer.invoke('save-config', config),
  loadConfig:     () => ipcRenderer.invoke('load-config'),
  saveAppearance: (appearance) => ipcRenderer.invoke('save-appearance', appearance),
  loadAppearance: () => ipcRenderer.invoke('load-appearance'),

  // ── RUTAS ───────────────────────────────────────────────────────
  getPaths: () => ipcRenderer.invoke('get-paths'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
  activateLicense: (text) => ipcRenderer.invoke('activate-license', text),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  listAppReleases: () => ipcRenderer.invoke('list-app-releases'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  installUpdateQuit: () => ipcRenderer.invoke('install-update-quit'),

  // ── CONTROLES DE VENTANA ────────────────────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose:    () => ipcRenderer.invoke('window-close'),

  // ── ESCUCHAR EVENTOS DEL PS1 ────────────────────────────────────
  // El main.js envía estos eventos cuando el PS1 produce output
  onPsData:    (callback) => ipcRenderer.on('ps-data',    (_, data) => callback(data)),
  onPsLog:     (callback) => ipcRenderer.on('ps-log',     (_, data) => callback(data)),
  onPsError:   (callback) => ipcRenderer.on('ps-error',   (_, data) => callback(data)),
  onPsStarted: (callback) => ipcRenderer.on('ps-started', (_, data) => callback(data)),
  onPsStopped: (callback) => ipcRenderer.on('ps-stopped', (_, data) => callback(data)),
  onAppUpdate: (callback) => ipcRenderer.on('app-update', (_, data) => callback(data)),
  onLicenseStatus: (callback) => ipcRenderer.on('license-status', (_, data) => callback(data)),

  // Limpiar listeners (importante para evitar memory leaks)
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
